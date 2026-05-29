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
 *    10. Replay.reserve(txKey(chainId, txHash)). Already-consumed/rejected/
 *        inflight → terminal throw.
 *    11. sendRawTransaction(payload.signature). Error categorization:
 *        - already-known / nonce-too-low / underpriced (replacement) →
 *          getTransactionReceipt(txHash); if found, continue to step 13.
 *          If not found, getTransaction(txHash) (mempool check); if
 *          pending, continue to step 12. Otherwise release + throw.
 *        - other errors (invalid sig / fee insufficient / chainId
 *          mismatch on node / malformed RLP) → release + throw.
 *    12. waitForTransactionReceipt(txHash). Timeout → keep inflight (TTL
 *        sweeps later); throw retryable verification error. DO NOT
 *        construct a Payment-Receipt (draft §7.6: receipt only on success).
 *    13. receipt.status === 'success'. Reverted → markRejected + throw.
 *    14. parseEventLogs(Transfer) finds (address=currency, from=recoveredSender,
 *        to=recipient, value=amount). No match → markRejected + throw.
 *    15. Replay.markConsumed.
 *    16. buildEvmReceipt with txHash as `reference` + echo externalId.
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

import { type EvmReceipt, buildEvmReceipt } from './Receipt.js'
import {
  type ChargeStore,
  getReplaySlot,
  markConsumed,
  markRejected,
  release,
  reserve,
  txKey,
} from './Replay.js'

/* -------------------------------------------------------------------------- */
/*  ctx + args                                                                */
/* -------------------------------------------------------------------------- */

export interface TransactionVerifierCtx {
  readonly publicClient: PublicClient
  readonly store: ChargeStore
  readonly chainId: number
  readonly confirmations: number
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

const TRANSFER_EVENT_ABI = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const

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
/*  Error categorization for sendRawTransaction                               */
/* -------------------------------------------------------------------------- */

/**
 * Match node error messages that MAY indicate the tx was already
 * broadcast / mined / replaced. We MUST check the receipt before
 * releasing the slot — blindly releasing on these would let a client
 * resubmit a tx that already settled.
 *
 * Sources: geth / erigon / bsc-geth / arbitrum-nitro error strings.
 */
const POSSIBLY_ACCEPTED_ERROR_PATTERNS = [
  /already known/i,
  /known transaction/i,
  /nonce too low/i,
  /replacement transaction underpriced/i,
  /transaction underpriced.*replacement/i,
  /transaction with the same hash/i,
]

function isPossiblyAcceptedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return POSSIBLY_ACCEPTED_ERROR_PATTERNS.some((re) => re.test(message))
}

/* -------------------------------------------------------------------------- */
/*  verifyTransaction                                                         */
/* -------------------------------------------------------------------------- */

export async function verifyTransaction({
  credential,
  request,
  ctx,
}: TransactionVerifierArgs): Promise<EvmReceipt> {
  const { publicClient, store, chainId, confirmations } = ctx
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

  if (credential.source !== undefined) {
    const sourcePattern = new RegExp(`^did:pkh:eip155:${chainId}:(0x[0-9a-fA-F]{40})$`)
    const sourceMatch = sourcePattern.exec(credential.source)
    if (!sourceMatch) {
      throw new Errors.VerificationFailedError({
        ...(challengeId && { id: challengeId }),
        reason: `credential.source must match 'did:pkh:eip155:${chainId}:<address>'; got '${credential.source}'`,
      })
    }
    if (sourceMatch[1]!.toLowerCase() !== recoveredSender.toLowerCase()) {
      throw new Errors.VerificationFailedError({
        ...(challengeId && { id: challengeId }),
        reason: `credential.source (${sourceMatch[1]}) does not match recovered sender (${recoveredSender})`,
      })
    }
  }

  // ── Steps 9-10: compute txHash, atomic reserve ─────────────────────────
  const txHash = keccak256(serializedTx) as `0x${string}`
  const key = txKey(chainId, txHash)
  const claimed = await reserve(store, key)
  if (!claimed) {
    // Normalized read so a backend failure here surfaces as
    // ReplayStoreUnavailableError instead of a raw Redis/Postgres error.
    const current = await getReplaySlot(store, key)
    const reasonText =
      current?.state === 'consumed'
        ? `transaction credential already consumed (txHash=${txHash})`
        : current?.state === 'rejected'
          ? `transaction credential previously rejected: ${current.reason ?? 'unknown'}`
          : `concurrent verify in progress for transaction credential (txHash=${txHash})`
    throw new Errors.VerificationFailedError({
      ...(challengeId && { id: challengeId }),
      reason: reasonText,
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
    let broadcastSucceeded = false
    try {
      await publicClient.sendRawTransaction({ serializedTransaction: serializedTx })
      broadcastSucceeded = true
    } catch (sendErr) {
      if (!isPossiblyAcceptedError(sendErr)) {
        // Definitely-not-accepted: invalid signature / fee insufficient /
        // chainId mismatch / malformed RLP. Release and surface.
        await release(store, key)
        throw new Errors.VerificationFailedError({
          ...(challengeId && { id: challengeId }),
          reason: `sendRawTransaction rejected: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`,
        })
      }
      // Possibly-accepted: check receipt before releasing.
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
          // landed. TTL handles cleanup. Surface as retryable.
          throw new Errors.VerificationFailedError({
            ...(challengeId && { id: challengeId }),
            reason: `getTransactionReceipt RPC error after possibly-accepted send (slot stays inflight, TTL cleanup): ${
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
              reason: `sendRawTransaction failed with possibly-accepted error but tx not in mempool: ${
                sendErr instanceof Error ? sendErr.message : String(sendErr)
              }`,
            })
          }
          // In mempool → fall through to waitForTransactionReceipt below
        } catch (mempoolErr) {
          if (mempoolErr instanceof Errors.VerificationFailedError) throw mempoolErr
          if (mempoolErr instanceof TransactionNotFoundError) {
            // Confirmed not in mempool either → release (nonce unconsumed).
            await release(store, key)
            throw new Errors.VerificationFailedError({
              ...(challengeId && { id: challengeId }),
              reason: `sendRawTransaction failed and txHash ${txHash} not found in mempool: ${
                sendErr instanceof Error ? sendErr.message : String(sendErr)
              }`,
            })
          }
          // RPC failure on getTransaction — keep inflight (TTL cleanup)
          throw new Errors.VerificationFailedError({
            ...(challengeId && { id: challengeId }),
            reason: `getTransaction RPC error after possibly-accepted send (slot stays inflight, TTL cleanup): ${
              mempoolErr instanceof Error ? mempoolErr.message : String(mempoolErr)
            }`,
          })
        }
      }
    }
    void broadcastSucceeded

    // ── Step 12: wait for receipt (with confirmations) ────────────────
    let receipt: Awaited<ReturnType<PublicClient['waitForTransactionReceipt']>>
    try {
      receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations,
      })
    } catch (waitErr) {
      // Timeout: keep slot inflight per spec §8.3 step 12 (TTL handles
      // cleanup). Throw retryable; do NOT mark rejected, do NOT release —
      // letting the client retry would otherwise lose the inflight marker
      // and risk concurrent broadcast attempts.
      throw new Errors.VerificationFailedError({
        ...(challengeId && { id: challengeId }),
        reason: `waitForTransactionReceipt timed out or RPC failed; slot remains inflight (TTL cleanup): ${
          waitErr instanceof Error ? waitErr.message : String(waitErr)
        }`,
      })
    }

    // waitForTransactionReceipt returned → tx mined (success or
    // revert). The user's nonce was consumed by gas payment regardless;
    // we're now in terminal phase. Safety-net release is locked out.
    terminalPhase = true

    // ── Step 13: receipt.status ───────────────────────────────────────
    if (receipt.status !== 'success') {
      await markRejected(store, key, `tx reverted on-chain (status=${receipt.status})`)
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
      throw new Errors.VerificationFailedError({
        ...(challengeId && { id: challengeId }),
        reason: `no matching Transfer event for currency=${currency} from=${recoveredSender} to=${recipient} value=${amount}`,
      })
    }

    // ── Step 15: mark consumed ────────────────────────────────────────
    await markConsumed(store, key)

    // ── Step 16: build receipt ────────────────────────────────────────
    return buildEvmReceipt({
      method: 'evm',
      status: 'success',
      challengeId,
      reference: txHash,
      timestamp: new Date().toISOString(),
      chainId,
      ...(externalId !== undefined && { externalId }),
    })
  } catch (err) {
    // Safety net: unexpected errors leave the slot inflight unless the
    // step's failure path already mutated it. Release on bubbling-out of
    // unknown errors so the user can retry; VerificationFailedError paths
    // already handled the slot.
    //
    // The secondary release() call MUST NOT mask `err`. If
    // the store backend itself is the cause (ReplayStoreUnavailableError
    // from earlier reserve / markConsumed), release() will throw too —
    // swallow+log so the user sees the original failure.
    //
    // If `terminalPhase` is set, the tx is mined (nonce consumed
    // by gas) and a terminal store-write was in flight. Releasing here
    // would re-admit a credential whose nonce is already burned, and the
    // next reserve+verify cycle would broadcast a NEW tx with the SAME
    // signed RLP and fail "already known" → indefinite retry storm.
    // Keep the slot inflight; TTL or operator handles cleanup.
    if (err instanceof Errors.VerificationFailedError) throw err
    if (terminalPhase) {
      // eslint-disable-next-line no-console -- terminal-phase operator hint
      console.warn(
        '[verifyTransaction] terminal-phase store write failed; slot remains inflight ' +
          '(TTL cleanup) to avoid double-spend. Original error:',
        err instanceof Error ? err.message : String(err),
      )
      throw err
    }
    try {
      await release(store, key)
    } catch (cleanupErr) {
      // eslint-disable-next-line no-console -- intentional one-off operator hint
      console.warn(
        '[verifyTransaction] safety-net release failed; original error takes precedence:',
        cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      )
    }
    throw err
  }
}
