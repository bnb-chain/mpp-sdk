/**
 * Transaction credential verifier (spec §8.3).
 *
 * The credential carries the full signed RLP-encoded transaction. The
 * verifier parses + locally validates it (steps 1-8) BEFORE atomic-reserving
 * a replay slot, then broadcasts (or recovers if already-broadcast), waits
 * for receipt, and applies the same Transfer-log + status checks as the
 * hash verifier.
 *
 * Algorithm (cheap-reject ordered; spec §8.3):
 *
 *   Local validation (no RPC, no slot reservation):
 *     1. parseTransaction(payload.signature)
 *     2. type === 'eip1559' (no legacy / type-0 / type-1 / future-unknown)
 *     3. chainId === methodDetails.chainId
 *     4. to === currency (the ERC-20 contract)
 *     5. value === 0n (ERC-20 transfer must not carry native value)
 *     6. data starts with 0xa9059cbb (ERC-20 transfer selector)
 *     7. decode(data) → (to, amount) strictly equals (request.recipient,
 *        request.amount)
 *     8. recoveredSender = recoverTransactionSender(payload.signature).
 *        If credential.source is present, verify it matches the recovered
 *        address (did:pkh:eip155:<chainId>:<addr>).
 *
 *   On-chain (after step-1-8 pass):
 *     9. txHash = keccak256(payload.signature)
 *    10. Replay.reserve(txHashKey(chainId, txHash)) — keyspace shared with
 *        the hash verifier (spec §8: both types use the tx hash as the
 *        replay token). Already-consumed/rejected/inflight → terminal throw.
 *    11. sendRawTransaction(payload.signature). On ANY send error:
 *        getTransactionReceipt(txHash); if found, continue to step 13.
 *        If not found, getTransaction(txHash) (mempool check); if
 *        pending, continue to step 12. Neither → probe
 *        getTransactionCount(sender): nonce already consumed → the tx
 *        was likely replaced (repriced) → keep inflight + retryable;
 *        nonce unconsumed → genuine rejection → release + throw. (No
 *        message-pattern matching: node families phrase "already known"
 *        / "nonce too low" differently; the receipt/mempool/nonce
 *        lookups answer the question authoritatively.)
 *    12. waitForTransactionReceipt(txHash). Timeout → keep inflight;
 *        throw retryable verification error. DO NOT construct a
 *        Payment-Receipt (draft §7.6: receipt only on success).
 *    12.5 Replacement detection: if receipt.transactionHash != txHash,
 *        viem followed a same-(from, nonce) replacement. Claim the mined
 *        hash's replay slot too (already consumed/rejected → reject this
 *        credential). All later checks run against the mined receipt.
 *    13. receipt.status === 'success'. Reverted → markRejected (both
 *        hashes on replacement) + throw.
 *    14. parseEventLogs(Transfer) finds (address=currency, from=recoveredSender,
 *        to=recipient, value=amount). No match → markRejected + throw
 *        (replacement slot released — it may pay a different charge).
 *    15. consumeSlotBestEffort — both hashes on replacement, MINED hash
 *        FIRST (it guards the transfer that actually settled on-chain).
 *    16. buildEvmReceipt with the MINED hash as `reference` + echo externalId.
 */

import { type Credential, Errors } from 'mppx'
import {
  type Hex,
  type PublicClient,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  decodeFunctionData,
  keccak256,
  parseEventLogs,
  parseTransaction,
  recoverTransactionAddress,
} from 'viem'

import {
  TRANSFER_EVENT_ABI,
  assertDidPkhSourceMatches,
  consumeSlotBestEffort,
  handleVerifierFailure,
  throwReserveConflict,
} from './charge/verifierKit.js'
import { type EvmReceipt, buildEvmReceipt } from './Receipt.js'
import {
  type ChargeStore,
  getReplaySlot,
  markRejected,
  release,
  reserve,
  txHashKey,
} from './Replay.js'

/* -------------------------------------------------------------------------- */
/*  ctx + args                                                                */
/* -------------------------------------------------------------------------- */

export interface TransactionVerifierCtx {
  readonly publicClient: PublicClient
  readonly store: ChargeStore
  readonly chainId: number
  readonly confirmations: number
  /**
   * Max milliseconds to wait for the broadcast receipt. Unset → viem
   * default (180s). See Permit2VerifierCtx.settlementTimeoutMs.
   */
  readonly settlementTimeoutMs?: number
  /** Stale-inflight reclaim age forwarded to Replay.reserve. */
  readonly inflightTtlMs?: number
}

export interface TransactionVerifierArgs {
  readonly credential: Credential.Credential<{ type: 'transaction'; signature: `0x${string}` }>
  readonly request: {
    readonly amount: string
    readonly currency: `0x${string}`
    readonly recipient: `0x${string}`
    readonly externalId?: string
  }
  readonly ctx: TransactionVerifierCtx
}

/* -------------------------------------------------------------------------- */
/*  ABI fragments                                                             */
/* -------------------------------------------------------------------------- */

/** ERC-20 `transfer(address,uint256)` function. Selector: 0xa9059cbb. */
const ERC20_TRANSFER_FUNCTION_ABI = [
  {
    type: 'function',
    name: 'transfer',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
    stateMutability: 'nonpayable',
  },
] as const

/** keccak256("transfer(address,uint256)").slice(0,4) → 0xa9059cbb */
const TRANSFER_SELECTOR = '0xa9059cbb'

/* -------------------------------------------------------------------------- */
/*  verifyTransaction                                                         */
/* -------------------------------------------------------------------------- */

export async function verifyTransaction({
  credential,
  request,
  ctx,
}: TransactionVerifierArgs): Promise<EvmReceipt> {
  const { publicClient, store, chainId, confirmations, settlementTimeoutMs, inflightTtlMs } = ctx
  const { signature: rawTx } = credential.payload
  const { amount, currency, recipient, externalId } = request
  const challengeId = credential.challenge.id

  // ── Steps 1-8: local validation (no RPC, no slot reservation) ──────────
  let parsed: ReturnType<typeof parseTransaction>
  try {
    parsed = parseTransaction(rawTx)
  } catch (err) {
    throw new Errors.VerificationFailedError({
      ...(challengeId && { id: challengeId }),
      reason: `parseTransaction failed: ${err instanceof Error ? err.message : String(err)}`,
    })
  }

  // Step 2: type must be eip1559
  if (parsed.type !== 'eip1559') {
    throw new Errors.VerificationFailedError({
      ...(challengeId && { id: challengeId }),
      reason: `transaction type '${parsed.type}' not supported; require 'eip1559'`,
    })
  }

  // Type narrows: after step 2, rawTx is the EIP-1559 (type 2) serialized
  // form — viem's serializedTransaction parameter is tagged with the
  // leading 0x02 byte. Cast once + reuse for all downstream RPC calls.
  const serializedTx = rawTx as `0x02${string}`

  // Step 3: chainId match
  if (parsed.chainId !== chainId) {
    throw new Errors.VerificationFailedError({
      ...(challengeId && { id: challengeId }),
      reason: `tx chainId ${parsed.chainId} != methodDetails.chainId ${chainId}`,
    })
  }

  // Step 4: to is the ERC-20 contract
  if (!parsed.to || parsed.to.toLowerCase() !== currency.toLowerCase()) {
    throw new Errors.VerificationFailedError({
      ...(challengeId && { id: challengeId }),
      reason: `tx.to ${parsed.to ?? '<missing>'} does not match currency ${currency}`,
    })
  }

  // Step 5: native value must be zero.
  //
  // Use `?? 0n` not truthy-guard. Per RLP encoding, an
  // omitted `value` field is semantically equal to 0n; viem's
  // parseTransaction surfaces it as `undefined` (omitted) OR `0n`
  // (explicit zero) — both are valid "no native value attached". The
  // old `parsed.value && ...` short-circuited on undefined AND on 0n,
  // which gave correct behavior but for the wrong reason: a future
  // viem version that returned `null` / a string for a non-EIP-1559
  // envelope would silently fall through. Explicit nullish coalesce
  // makes the intent visible.
  if ((parsed.value ?? 0n) !== 0n) {
    throw new Errors.VerificationFailedError({
      ...(challengeId && { id: challengeId }),
      reason: `tx.value ${parsed.value} must be 0 (ERC-20 transfer carries no native value)`,
    })
  }

  // Step 6: data prefix is transfer selector
  if (!parsed.data || !parsed.data.toLowerCase().startsWith(TRANSFER_SELECTOR)) {
    throw new Errors.VerificationFailedError({
      ...(challengeId && { id: challengeId }),
      reason: `tx.data does not begin with ERC-20 transfer() selector ${TRANSFER_SELECTOR}`,
    })
  }

  // Step 7: decode transfer args + strict match
  let decoded: { to: `0x${string}`; amount: bigint }
  try {
    const result = decodeFunctionData({
      abi: ERC20_TRANSFER_FUNCTION_ABI,
      data: parsed.data as Hex,
    })
    if (result.functionName !== 'transfer') {
      throw new Error(`expected transfer() but got ${result.functionName}`)
    }
    const [toArg, amountArg] = result.args
    decoded = { to: toArg as `0x${string}`, amount: amountArg as bigint }
  } catch (err) {
    throw new Errors.VerificationFailedError({
      ...(challengeId && { id: challengeId }),
      reason: `failed to decode ERC-20 transfer() args: ${err instanceof Error ? err.message : String(err)}`,
    })
  }

  if (decoded.to.toLowerCase() !== recipient.toLowerCase()) {
    throw new Errors.VerificationFailedError({
      ...(challengeId && { id: challengeId }),
      reason: `tx transfer recipient ${decoded.to} != request recipient ${recipient}`,
    })
  }
  if (decoded.amount !== BigInt(amount)) {
    throw new Errors.VerificationFailedError({
      ...(challengeId && { id: challengeId }),
      reason: `tx transfer amount ${decoded.amount} != request amount ${amount}`,
    })
  }

  // Step 8: recover sender + optional source check
  let recoveredSender: `0x${string}`
  try {
    recoveredSender = await recoverTransactionAddress({ serializedTransaction: serializedTx })
  } catch (err) {
    throw new Errors.VerificationFailedError({
      ...(challengeId && { id: challengeId }),
      reason: `recoverTransactionAddress failed: ${err instanceof Error ? err.message : String(err)}`,
    })
  }

  assertDidPkhSourceMatches({
    chainId,
    source: credential.source,
    required: false,
    expectedAddress: recoveredSender,
    challengeId,
    expectedLabel: 'recovered sender',
  })

  // ── Steps 9-10: compute txHash, atomic reserve ─────────────────────────
  const txHash = keccak256(serializedTx) as `0x${string}`
  const key = txHashKey(chainId, txHash)
  const claimed = await reserve(store, key, { inflightTtlMs })
  if (!claimed) {
    await throwReserveConflict({
      store,
      key,
      challengeId,
      describe: {
        consumed: `transaction credential already consumed (txHash=${txHash})`,
        rejected: (reason) => `transaction credential previously rejected: ${reason ?? 'unknown'}`,
        inflight: `concurrent verify in progress for transaction credential (txHash=${txHash})`,
      },
    })
  }

  // `terminalPhase` flips to `true` once we've made an on-chain
  // settlement decision (any waitForTransactionReceipt return — success
  // OR revert — consumes the user's nonce via gas). After that point,
  // markRejected (revert / log-mismatch) or markConsumed (success) is
  // the right store outcome; auto-release would re-admit a credential
  // whose nonce is already consumed → DOUBLE-SPEND on retry. The outer
  // safety net respects this flag and never releases when set.
  let terminalPhase = false
  try {
    // ── Step 11: broadcast ────────────────────────────────────────────
    try {
      await publicClient.sendRawTransaction({ serializedTransaction: serializedTx })
    } catch (sendErr) {
      // ANY send error gets the receipt/mempool fallback before the slot
      // is released. Errors like "already known" / "nonce too low" mean
      // the tx may already be mined or pending — but node families phrase
      // those differently (geth vs Nethermind vs Besu vs reth), so
      // pattern-matching the message is unreliable. The lookups below are
      // cheap and answer the only question that matters: did the tx land
      // (receipt), is it pending (mempool), or is it genuinely rejected
      // (neither → release + surface the send error)?
      try {
        const existing = await publicClient.getTransactionReceipt({ hash: txHash })
        // Receipt exists → proceed to step 13 with this receipt below
        // (re-run getTransactionReceipt at step 12; idempotent + simpler control flow).
        void existing
      } catch (receiptErr) {
        // Narrow the catch. Only TransactionReceiptNotFoundError
        // means "tx hasn't been mined yet" — every other class (RPC
        // timeout, 429 rate-limit, network drop, malformed JSON response)
        // is an RPC failure that we MUST NOT silently treat as "no
        // receipt yet → check mempool". Doing so would mask the actual
        // RPC problem, hand the user a misleading mempool-error message,
        // and could trigger a retry storm if the tx DID land but the
        // receipt lookup was momentarily unreachable.
        if (!(receiptErr instanceof TransactionReceiptNotFoundError)) {
          // Slot stays inflight — we genuinely don't know whether the tx
          // landed. reserve() reclaims the slot after inflightTtlMs.
          // Surface as retryable.
          throw new Errors.VerificationFailedError({
            ...(challengeId && { id: challengeId }),
            reason: `getTransactionReceipt RPC error after failed send (slot stays inflight until reclaim): ${
              receiptErr instanceof Error ? receiptErr.message : String(receiptErr)
            }`,
          })
        }
        // No receipt yet → check mempool. Same narrowing on getTransaction:
        // only TransactionNotFoundError means "not in mempool"; anything
        // else is an RPC failure that we surface separately so the operator
        // can tell "tx genuinely lost" from "RPC misbehaving".
        try {
          const mempoolTx = await publicClient.getTransaction({ hash: txHash })
          if (!mempoolTx) {
            await release(store, key)
            throw new Errors.VerificationFailedError({
              ...(challengeId && { id: challengeId }),
              reason: `sendRawTransaction rejected and tx not found on-chain or in mempool: ${
                sendErr instanceof Error ? sendErr.message : String(sendErr)
              }`,
            })
          }
          // In mempool → fall through to waitForTransactionReceipt below
        } catch (mempoolErr) {
          if (mempoolErr instanceof Errors.VerificationFailedError) throw mempoolErr
          if (mempoolErr instanceof TransactionNotFoundError) {
            // Not mined and not in mempool — but that alone is NOT proof
            // of a genuine rejection. If the payer's wallet repriced the
            // tx (same (from, nonce), different hash), the original hash
            // never mines yet the nonce IS consumed. Probe the sender's
            // account nonce before deciding: count > parsed.nonce means
            // SOME tx from this sender already consumed the slot's nonce.
            let senderNonce: number
            try {
              senderNonce = await publicClient.getTransactionCount({
                address: recoveredSender,
                blockTag: 'latest',
              })
            } catch (countErr) {
              // RPC failure on the nonce probe — we genuinely don't know
              // whether the nonce was consumed. Keep the slot inflight
              // (reserve() reclaims it after inflightTtlMs).
              throw new Errors.VerificationFailedError({
                ...(challengeId && { id: challengeId }),
                reason: `getTransactionCount RPC error after failed send (slot stays inflight until reclaim): ${
                  countErr instanceof Error ? countErr.message : String(countErr)
                }`,
              })
            }
            if (senderNonce > (parsed.nonce ?? 0)) {
              // The nonce was consumed by a DIFFERENT tx — the
              // credential's tx was replaced (repriced / sped-up).
              // Releasing would re-admit a credential that can never
              // mine; keep the slot inflight and point the payer at the
              // hash-credential path for the mined replacement.
              throw new Errors.VerificationFailedError({
                ...(challengeId && { id: challengeId }),
                reason:
                  'transaction appears to have been replaced (sender account nonce already ' +
                  'consumed); if you sped up the tx, present the mined transaction hash as a ' +
                  'hash credential',
              })
            }
            // Confirmed not mined, not in mempool, AND nonce unconsumed →
            // the send error was a genuine rejection; release.
            await release(store, key)
            throw new Errors.VerificationFailedError({
              ...(challengeId && { id: challengeId }),
              reason: `sendRawTransaction rejected and txHash ${txHash} not found on-chain or in mempool: ${
                sendErr instanceof Error ? sendErr.message : String(sendErr)
              }`,
            })
          }
          // RPC failure on getTransaction — keep inflight (reserve()
          // reclaims stale inflight slots after inflightTtlMs).
          throw new Errors.VerificationFailedError({
            ...(challengeId && { id: challengeId }),
            reason: `getTransaction RPC error after failed send (slot stays inflight until reclaim): ${
              mempoolErr instanceof Error ? mempoolErr.message : String(mempoolErr)
            }`,
          })
        }
      }
    }

    // ── Step 12: wait for receipt (with confirmations) ────────────────
    let receipt: Awaited<ReturnType<PublicClient['waitForTransactionReceipt']>>
    try {
      receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations,
        ...(settlementTimeoutMs !== undefined && { timeout: settlementTimeoutMs }),
      })
    } catch (waitErr) {
      // Timeout: keep slot inflight (reserve() reclaims stale inflight
      // slots after inflightTtlMs). Throw retryable; do NOT mark rejected,
      // do NOT release — letting the client retry would otherwise lose the
      // inflight marker and risk concurrent broadcast attempts.
      throw new Errors.VerificationFailedError({
        ...(challengeId && { id: challengeId }),
        reason: `waitForTransactionReceipt timed out or RPC failed; slot remains inflight until reclaim: ${
          waitErr instanceof Error ? waitErr.message : String(waitErr)
        }`,
      })
    }

    // waitForTransactionReceipt returned → tx mined (success or
    // revert). The user's nonce was consumed by gas payment regardless;
    // we're now in terminal phase. Safety-net release is locked out.
    terminalPhase = true

    // ── Step 12.5: replacement detection ──────────────────────────────
    // viem's waitForTransactionReceipt (checkReplacement default true)
    // resolves with the receipt of a same-(from, nonce) REPLACEMENT tx
    // when the credential's tx was repriced/cancelled out of the mempool.
    // The mined tx is then a different on-chain identity: all subsequent
    // status/Transfer checks run against IT, the receipt `reference` must
    // carry ITS hash, and ITS replay slot must be claimed too — otherwise
    // the actually-mined hash stays free and can settle a second charge
    // as a hash credential.
    const minedHash = receipt.transactionHash
    let minedKey: ReturnType<typeof txHashKey> | null = null
    if (minedHash.toLowerCase() !== txHash.toLowerCase()) {
      minedKey = txHashKey(chainId, minedHash)
      const minedClaimed = await reserve(store, minedKey, { inflightTtlMs })
      if (!minedClaimed) {
        const minedSlot = await getReplaySlot(store, minedKey)
        if (minedSlot?.state === 'consumed' || minedSlot?.state === 'rejected') {
          // The mined replacement already settled (or terminally failed)
          // another charge — this credential cannot be honored.
          await markRejected(
            store,
            key,
            `tx was replaced by ${minedHash}, which is already ${minedSlot.state} by another credential`,
          )
          throw new Errors.VerificationFailedError({
            ...(challengeId && { id: challengeId }),
            reason: `transaction was replaced on-chain by ${minedHash}, which already settled another charge`,
          })
        }
        // Replacement hash is concurrently inflight (e.g. presented in
        // parallel as a hash credential). Keep our slot inflight and
        // surface retryable — the concurrent verify will reach a terminal
        // state for the mined hash first. Note the honest retry window:
        // this credential's own slot also stays inflight until reserve()'s
        // stale-inflight reclaim (~inflightTtlMs), so an immediate retry
        // would just hit "concurrent verify in progress" on its own hash.
        throw new Errors.VerificationFailedError({
          ...(challengeId && { id: challengeId }),
          reason: `transaction was replaced by ${minedHash}, which has a concurrent verify in progress; this credential's slot remains inflight — retry after the inflight window expires`,
        })
      }
    }

    // ── Step 13: receipt.status ───────────────────────────────────────
    if (receipt.status !== 'success') {
      await markRejected(store, key, `tx reverted on-chain (status=${receipt.status})`)
      if (minedKey) {
        // The mined replacement reverted — on-chain-final evidence, mark
        // its hash rejected too so a hash credential doesn't re-verify it.
        await markRejected(store, minedKey, `tx reverted on-chain (status=${receipt.status})`)
      }
      throw new Errors.VerificationFailedError({
        ...(challengeId && { id: challengeId }),
        reason: `transaction reverted on-chain (status=${receipt.status})`,
      })
    }

    // ── Step 14: Transfer log match (recoveredSender as from) ─────────
    const transferLogs = parseEventLogs({
      abi: TRANSFER_EVENT_ABI,
      eventName: 'Transfer',
      logs: receipt.logs,
    })
    const expectedAmount = BigInt(amount)
    const currencyLower = currency.toLowerCase()
    const recipientLower = recipient.toLowerCase()
    const senderLower = recoveredSender.toLowerCase()
    const match = transferLogs.find(
      (log) =>
        log.address.toLowerCase() === currencyLower &&
        log.args.from.toLowerCase() === senderLower &&
        log.args.to.toLowerCase() === recipientLower &&
        log.args.value === expectedAmount,
    )
    if (!match) {
      await markRejected(
        store,
        key,
        `no matching Transfer(${currency}, from=${recoveredSender}, ${recipient}, ${amount}) in tx logs`,
      )
      if (minedKey) {
        // The mined replacement succeeded but didn't pay THIS charge. It
        // may legitimately match a different challenge — release its slot
        // instead of poisoning a future hash-credential verify of it.
        await release(store, minedKey)
      }
      throw new Errors.VerificationFailedError({
        ...(challengeId && { id: challengeId }),
        reason: `no matching Transfer event for currency=${currency} from=${recoveredSender} to=${recipient} value=${amount}`,
      })
    }

    // ── Step 15: mark consumed ────────────────────────────────────────
    // On replacement, consume BOTH hashes — the MINED hash FIRST: it
    // guards the transfer that actually settled on-chain (the one a hash
    // credential could redeem again), while the credential's precomputed
    // hash merely blocks resubmission of the same signed RLP. Each write
    // goes through consumeSlotBestEffort so it retries independently and
    // a failure on one key never skips the other.
    //
    // The payment settled and the Transfer log matched — a store failure
    // here must NOT surface as an error to a paid payer (the helper
    // warns instead of throwing). The slot staying inflight already
    // blocks replay; the receipt is their proof.
    if (minedKey) await consumeSlotBestEffort(store, minedKey, '[verifyTransaction]')
    await consumeSlotBestEffort(store, key, '[verifyTransaction]')

    // ── Step 16: build receipt ────────────────────────────────────────
    // `reference` is the hash that actually mined (spec §7.6: receipt
    // reference = the settlement transaction's hash). Equal to the
    // precomputed txHash except in the replacement case.
    return buildEvmReceipt({
      method: 'evm',
      status: 'success',
      challengeId,
      reference: minedHash,
      timestamp: new Date().toISOString(),
      chainId,
      ...(externalId !== undefined && { externalId }),
    })
  } catch (err) {
    // Safety net: unexpected errors leave the slot inflight unless the
    // step's failure path already mutated it (see handleVerifierFailure).
    //
    // If `terminalPhase` is set, the tx is mined (nonce consumed
    // by gas) and a terminal store-write was in flight. Releasing here
    // would re-admit a credential whose nonce is already burned, and the
    // next reserve+verify cycle would broadcast a NEW tx with the SAME
    // signed RLP and fail "already known" → indefinite retry storm.
    // Keep the slot inflight — reserve() reclaims it after inflightTtlMs
    // and the retry's broadcast-error fallback finds the mined receipt.
    return await handleVerifierFailure({
      err,
      store,
      key,
      terminalPhase,
      label: '[verifyTransaction]',
      cleanupNoun: 'release',
    })
  }
}
