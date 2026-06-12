/**
 * Hash credential verifier (spec §8.4).
 *
 * Verifies that a previously-broadcast transaction settled the requested
 * payment by checking its receipt for a matching `Transfer(token, recipient,
 * amount)` event. The credential payload is just `{ type: 'hash', hash }` —
 * the verifier does the entire correlation from the on-chain receipt.
 *
 * Algorithm (cheap-reject ordered; spec §8.4):
 *
 *   1. Atomic reserve via `Replay.reserve(txHashKey(chainId, txHash))` —
 *      keyspace shared with the transaction verifier (spec §8: both types
 *      use the tx hash as the replay token).
 *      - Already consumed → throw REPLAY (terminal).
 *      - Already rejected → throw REJECTED (terminal).
 *      - Already inflight → throw CONCURRENT.
 *   2. `publicClient.getTransactionReceipt({ hash })`.
 *      - Not found → `release` slot (tx may simply not be broadcast yet)
 *        and throw NOT_FOUND. DoS protection here is the deployment's
 *        rate-limiter, not a markRejected (that would let an attacker
 *        permanently poison a future legitimate tx hash).
 *   3. Confirmations check: `(latestBlock - receipt.blockNumber + 1) >=
 *      confirmations`. Fail → `release` and throw INSUFFICIENT.
 *   4. `receipt.status === 'success'`. Reverted → `markRejected` and throw
 *      REVERTED (on-chain final; permanent).
 *   5. `parseEventLogs(Transfer)` finds an event with
 *      `address === currency` AND `to === recipient` AND `value === amount`.
 *      No match → `markRejected` and throw LOGS_MISMATCH.
 *   6. If `hashFromPolicy === 'strict_from'`, require `credential.source`
 *      to be `did:pkh:eip155:${chainId}:${addr}` and `Transfer.from ===
 *      addr`. Fail → `markRejected` and throw FROM_MISMATCH.
 *      Default `'lax_from'` skips step 6 (draft §6.4 only requires the
 *      token/to/value triple).
 *   7. `markConsumed` (permanent).
 *   8. Return `buildEvmReceipt(...)` with the resolved txHash as `reference`.
 *
 * Address comparisons are lowercase-on-both-sides; the wire schema does
 * not enforce EIP-55 (draft §5 SHOULD, not MUST).
 */

import { type Credential, Errors } from 'mppx'
import { parseEventLogs, type PublicClient, TransactionReceiptNotFoundError } from 'viem'

import {
  TRANSFER_EVENT_ABI,
  consumeSlotBestEffort,
  handleVerifierFailure,
  throwReserveConflict,
} from './charge/verifierKit.js'
import { type EvmReceipt, buildEvmReceipt } from './Receipt.js'
import { type ChargeStore, markRejected, release, reserve, txHashKey } from './Replay.js'

/* -------------------------------------------------------------------------- */
/*  ctx + args                                                                */
/* -------------------------------------------------------------------------- */

export interface HashVerifierCtx {
  readonly publicClient: PublicClient
  readonly store: ChargeStore
  readonly chainId: number
  readonly confirmations: number
  readonly hashFromPolicy: 'strict_from' | 'lax_from'
  /** Stale-inflight reclaim age forwarded to Replay.reserve. */
  readonly inflightTtlMs?: number
}

export interface HashVerifierArgs {
  readonly credential: Credential.Credential<{ type: 'hash'; hash: `0x${string}` }>
  readonly request: {
    readonly amount: string
    readonly currency: `0x${string}`
    readonly recipient: `0x${string}`
    readonly externalId?: string
  }
  readonly ctx: HashVerifierCtx
}

/* -------------------------------------------------------------------------- */
/*  verifyHash                                                                */
/* -------------------------------------------------------------------------- */

export async function verifyHash({
  credential,
  request,
  ctx,
}: HashVerifierArgs): Promise<EvmReceipt> {
  const { publicClient, store, chainId, confirmations, hashFromPolicy, inflightTtlMs } = ctx
  const { hash: txHash } = credential.payload
  const { amount, currency, recipient, externalId } = request
  const challengeId = credential.challenge.id

  const key = txHashKey(chainId, txHash)

  // ── Step 1: atomic reserve ─────────────────────────────────────────────
  const claimed = await reserve(store, key, { inflightTtlMs })
  if (!claimed) {
    await throwReserveConflict({
      store,
      key,
      challengeId,
      describe: {
        consumed: `hash credential already consumed (txHash=${txHash})`,
        rejected: (reason) => `hash credential previously rejected: ${reason ?? 'unknown'}`,
        inflight: `concurrent verify in progress for hash credential (txHash=${txHash})`,
      },
    })
  }

  // From here on: any unhandled error path must release the slot so the
  // user can retry; explicit step failures handle release/markRejected
  // themselves (and re-throw).
  //
  // `terminalPhase` flips to `true` once we've confirmed the tx
  // exists on-chain (receipt fetched + confirmations satisfied). From
  // that point on, every store mutation is terminal — markRejected (for
  // revert / log-mismatch / strict_from failure) or markConsumed (for
  // success). If a terminal store-write throws (e.g. transient
  // ReplayStoreUnavailableError), the slot MUST stay inflight: the
  // on-chain state has already committed, and `release()` here would
  // let the same credential pass `reserve()` again → DOUBLE-SPEND.
  // reserve() reclaims the slot after inflightTtlMs; the retry then
  // re-reads the (idempotent) on-chain receipt.
  let terminalPhase = false
  try {
    // ── Steps 2+3a: receipt + latest block (independent reads, parallel) ─
    let receipt: Awaited<ReturnType<PublicClient['getTransactionReceipt']>>
    let latestBlock: bigint
    try {
      ;[receipt, latestBlock] = await Promise.all([
        publicClient.getTransactionReceipt({ hash: txHash }),
        publicClient.getBlockNumber(),
      ])
    } catch (rpcErr) {
      // Both failures are retryable — release the slot. But distinguish
      // the messages: "receipt not found" (tx may not be broadcast yet)
      // is client-actionable; a generic RPC failure (timeout / 429 /
      // network) is operator-actionable and must not masquerade as
      // "tx not broadcast".
      await release(store, key)
      if (rpcErr instanceof TransactionReceiptNotFoundError) {
        throw new Errors.VerificationFailedError({
          ...(challengeId && { id: challengeId }),
          reason: `transaction receipt not found for ${txHash} — tx may not be broadcast yet`,
        })
      }
      throw new Errors.VerificationFailedError({
        ...(challengeId && { id: challengeId }),
        reason: `RPC error while fetching receipt/block number for ${txHash}: ${
          rpcErr instanceof Error ? rpcErr.message : String(rpcErr)
        }`,
      })
    }

    // ── Step 3: confirmations depth ────────────────────────────────────
    const txConfirmations =
      latestBlock >= receipt.blockNumber ? latestBlock - receipt.blockNumber + 1n : 0n
    if (txConfirmations < BigInt(confirmations)) {
      await release(store, key)
      throw new Errors.VerificationFailedError({
        ...(challengeId && { id: challengeId }),
        reason: `insufficient confirmations: have ${txConfirmations}, need ${confirmations}`,
      })
    }

    // Tx confirmed on-chain → enter terminal phase. From here, no
    // automatic release on safety-net catch. The on-chain decision (even
    // if revert) is committed; releasing the slot would re-admit a
    // credential whose nonce/hash is already known.
    terminalPhase = true

    // ── Step 4: receipt.status ─────────────────────────────────────────
    if (receipt.status !== 'success') {
      await markRejected(store, key, `tx reverted on-chain (status=${receipt.status})`)
      throw new Errors.VerificationFailedError({
        ...(challengeId && { id: challengeId }),
        reason: `transaction reverted on-chain (status=${receipt.status})`,
      })
    }

    // ── Step 5: Transfer log match ─────────────────────────────────────
    const transferLogs = parseEventLogs({
      abi: TRANSFER_EVENT_ABI,
      eventName: 'Transfer',
      logs: receipt.logs,
    })
    const expectedAmount = BigInt(amount)
    const currencyLower = currency.toLowerCase()
    const recipientLower = recipient.toLowerCase()
    const match = transferLogs.find(
      (log) =>
        log.address.toLowerCase() === currencyLower &&
        log.args.to.toLowerCase() === recipientLower &&
        log.args.value === expectedAmount,
    )
    if (!match) {
      await markRejected(
        store,
        key,
        `no matching Transfer(${currency}, ${recipient}, ${amount}) in tx logs`,
      )
      throw new Errors.VerificationFailedError({
        ...(challengeId && { id: challengeId }),
        reason: `no matching Transfer event for currency=${currency} to=${recipient} value=${amount}`,
      })
    }

    // ── Step 6: strict_from (skip in lax_from default) ─────────────────
    if (hashFromPolicy === 'strict_from') {
      const source = credential.source
      if (source === undefined) {
        await markRejected(store, key, 'strict_from policy requires credential.source')
        throw new Errors.VerificationFailedError({
          ...(challengeId && { id: challengeId }),
          reason:
            "hashFromPolicy='strict_from' requires credential.source field " +
            `(expected 'did:pkh:eip155:${chainId}:<address>')`,
        })
      }
      const expected = new RegExp(`^did:pkh:eip155:${chainId}:(0x[0-9a-fA-F]{40})$`)
      const matchSource = expected.exec(source)
      if (!matchSource) {
        await markRejected(store, key, `credential.source format mismatch: ${source}`)
        throw new Errors.VerificationFailedError({
          ...(challengeId && { id: challengeId }),
          reason: `credential.source must match 'did:pkh:eip155:${chainId}:<address>'; got '${source}'`,
        })
      }
      const sourceAddress = matchSource[1]!.toLowerCase()
      if (match.args.from.toLowerCase() !== sourceAddress) {
        await markRejected(
          store,
          key,
          `Transfer.from (${match.args.from}) does not match credential.source (${sourceAddress})`,
        )
        throw new Errors.VerificationFailedError({
          ...(challengeId && { id: challengeId }),
          reason: `Transfer.from ${match.args.from} does not match credential.source ${sourceAddress}`,
        })
      }
    }

    // ── Step 7: mark consumed ──────────────────────────────────────────
    // The on-chain payment is confirmed — a store failure here must NOT
    // surface as an error to a paid payer. consumeSlotBestEffort retries
    // transient blips and warns (never throws) on a sustained outage; the
    // slot staying inflight still blocks replay until the reclaim TTL
    // (residual risk documented in docs/replay-store.md).
    await consumeSlotBestEffort(store, key, '[verifyHash]')

    // ── Step 8: build receipt ──────────────────────────────────────────
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
    // Safety net: if we land here without explicit release / markRejected
    // (unexpected RPC throw, log-parse throw, etc.) the slot would stay
    // inflight forever (see handleVerifierFailure).
    //
    // If `terminalPhase` is set, the tx is confirmed on-chain
    // AND a terminal store-write was about to commit (or did commit) —
    // releasing the slot here would let the same credential pass
    // `reserve()` again, opening a DOUBLE-SPEND window. Leave the slot
    // inflight (reclaimed after inflightTtlMs). Surface the original
    // error so callers can act on it.
    return await handleVerifierFailure({
      err,
      store,
      key,
      terminalPhase,
      label: '[verifyHash]',
      cleanupNoun: 'release',
    })
  }
}
