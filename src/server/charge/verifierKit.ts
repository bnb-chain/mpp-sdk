/**
 * Shared building blocks for the four credential verifiers
 * (Permit2 / Authorization / Transaction / Hash).
 *
 * Extracted so slot-lifecycle and signature handling stay byte-identical
 * across verifiers — the audit found the same blocks copy-pasted 2-4x
 * and already drifting.
 */

import { Errors } from 'mppx'
import {
  type Address,
  type Hex,
  compactSignatureToSignature,
  parseCompactSignature,
  serializeSignature,
} from 'viem'

import {
  type ChargeStore,
  type ReplayKey,
  getReplaySlot,
  markConsumed,
  release,
} from '../Replay.js'

/**
 * Normalize a wire signature to the canonical 65-byte r||s||v form with a
 * legacy (27/28) recovery byte.
 *
 * The wire schema (src/Methods.ts `evmSignature`) accepts:
 *   - 64-byte EIP-2098 compact signatures, and
 *   - 65-byte signatures whose final byte is 27/28 (legacy v) OR 0/1
 *     (yParity — emitted by some hardware wallets / raw secp256k1 libs).
 *
 * Downstream consumers are stricter:
 *   - viem's `parseSignature` returns `v: undefined` for the yParity form,
 *   - on-chain `ecrecover` (Permit2's SignatureVerification, EIP-3009's
 *     transferWithAuthorization) requires v ∈ {27, 28} — a yParity final
 *     byte recovers to address(0) and reverts InvalidSigner.
 *
 * Normalizing once here means EIP-712 recovery, `parseSignature`, and the
 * on-chain calls all see one canonical shape.
 */
export function normalizeEvmSignature(signature: Hex): Hex {
  const hexLen = signature.length - 2 // strip 0x
  if (hexLen === 128) {
    // EIP-2098 compact → standard 65-byte (serializeSignature emits v 27/28).
    return serializeSignature(compactSignatureToSignature(parseCompactSignature(signature)))
  }
  if (hexLen === 130) {
    const vByte = Number.parseInt(signature.slice(-2), 16)
    if (vByte === 0 || vByte === 1) {
      return `${signature.slice(0, -2)}${(vByte + 27).toString(16)}` as Hex
    }
  }
  return signature
}

/* -------------------------------------------------------------------------- */
/*  Shared ABI fragments                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Minimal ERC-20 `Transfer(address,address,uint256)` event fragment for
 * `parseEventLogs`. Sufficient — the verifiers only need `from / to /
 * value` decoded from the topic + data layout.
 */
export const TRANSFER_EVENT_ABI = [
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

/* -------------------------------------------------------------------------- */
/*  Reserve-conflict diagnostic                                               */
/* -------------------------------------------------------------------------- */

/**
 * Diagnose a failed `Replay.reserve()` and throw the verifier's terminal
 * VerificationFailedError.
 *
 * Routes the diagnostic read through `getReplaySlot` so a backend failure
 * surfaces as ReplayStoreUnavailableError instead of a raw Redis/Postgres
 * error leaking to the caller. The three message strings are supplied by
 * the verifier so each keeps its exact historical wording (tests assert
 * the messages verbatim).
 */
export async function throwReserveConflict(args: {
  store: ChargeStore
  key: ReplayKey
  challengeId: string | undefined
  describe: {
    /** Reason when the slot is already `consumed`. */
    consumed: string
    /** Reason when the slot is `rejected`; receives the stored rejection reason. */
    rejected: (reason: string | undefined) => string
    /** Reason when the slot is `inflight` (concurrent verify in progress). */
    inflight: string
  }
}): Promise<never> {
  const { store, key, challengeId, describe } = args
  const current = await getReplaySlot(store, key)
  const reasonText =
    current?.state === 'consumed'
      ? describe.consumed
      : current?.state === 'rejected'
        ? describe.rejected(current.reason)
        : describe.inflight
  throw new Errors.VerificationFailedError({
    ...(challengeId && { id: challengeId }),
    reason: reasonText,
  })
}

/* -------------------------------------------------------------------------- */
/*  Safety-net catch                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Shared terminal-phase-aware safety net for the verifiers' outer catch.
 *
 * - `VerificationFailedError` → rethrow untouched: its throw path already
 *   handled the slot (release / markRejected / keep-inflight).
 * - `terminalPhase` set → the on-chain decision is committed (nonce burned
 *   / tx mined). Releasing would re-admit a credential whose on-chain
 *   identity is spent — DOUBLE-SPEND on retry. Keep the slot inflight;
 *   `reserve()` reclaims it after inflightTtlMs and the retry re-checks
 *   on-chain state.
 * - Otherwise → best-effort `release()` so the user can retry. The cleanup
 *   call MUST NOT mask the original `err`: if the store backend itself is
 *   the cause (e.g. reserve threw ReplayStoreUnavailableError), release()
 *   throws too — swallow + warn so the user sees the original failure.
 *   (`release()` is a noop on consumed/rejected slots, so calling it
 *   unconditionally is safe.)
 */
export async function handleVerifierFailure(args: {
  err: unknown
  store: ChargeStore
  key: ReplayKey
  terminalPhase: boolean
  /** Warn-label prefix, e.g. '[verifyPermit2]'. */
  label: string
  /** Word the verifier's cleanup-failure warn historically used. */
  cleanupNoun: 'cleanup' | 'release'
}): Promise<never> {
  const { err, store, key, terminalPhase, label, cleanupNoun } = args
  if (err instanceof Errors.VerificationFailedError) throw err
  if (terminalPhase) {
    // eslint-disable-next-line no-console -- terminal-phase operator hint
    console.warn(
      `${label} terminal-phase store write failed; slot remains inflight ` +
        '(reclaimed after inflightTtlMs) to avoid double-spend. Original error:',
      err instanceof Error ? err.message : String(err),
    )
    throw err
  }
  try {
    await release(store, key)
  } catch (cleanupErr) {
    // eslint-disable-next-line no-console -- intentional one-off operator hint
    console.warn(
      `${label} safety-net ${cleanupNoun} failed; original error takes precedence:`,
      cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
    )
  }
  throw err
}

/* -------------------------------------------------------------------------- */
/*  did:pkh source binding                                                    */
/* -------------------------------------------------------------------------- */

/**
 * did:pkh `credential.source` ↔ recovered-address binding check
 * (draft §6.1).
 *
 * Permit2 REQUIRES `credential.source`; authorization / transaction treat
 * it as optional (their payload carries the authoritative identity) but
 * MUST verify it when present. Message fragments are parameterized so each
 * verifier keeps its exact historical wording (tests assert the messages
 * verbatim). The hash verifier's strict_from check is intentionally NOT
 * served by this helper — it compares against the Transfer log's `from`
 * and performs markRejected store writes before throwing.
 */
export function assertDidPkhSourceMatches(args: {
  chainId: number
  source: string | undefined
  required: boolean
  /** Address the source must bind to (recovered signer / sender). */
  expectedAddress: Address
  challengeId: string | undefined
  /** Reason thrown when `required` and the source is missing. */
  requiredReason?: string
  /** Names the expected address in the mismatch reason, e.g. 'recovered sender'. */
  expectedLabel: string
}): void {
  const { chainId, source, required, expectedAddress, challengeId, requiredReason, expectedLabel } =
    args
  if (source === undefined) {
    if (!required) return
    throw new Errors.VerificationFailedError({
      ...(challengeId && { id: challengeId }),
      reason:
        requiredReason ??
        `credential.source is required (expected 'did:pkh:eip155:${chainId}:${expectedAddress}')`,
    })
  }
  const sourcePattern = new RegExp(`^did:pkh:eip155:${chainId}:(0x[0-9a-fA-F]{40})$`)
  const sourceMatch = sourcePattern.exec(source)
  if (!sourceMatch) {
    throw new Errors.VerificationFailedError({
      ...(challengeId && { id: challengeId }),
      reason: `credential.source must match 'did:pkh:eip155:${chainId}:<address>'; got '${source}'`,
    })
  }
  if (sourceMatch[1]!.toLowerCase() !== expectedAddress.toLowerCase()) {
    throw new Errors.VerificationFailedError({
      ...(challengeId && { id: challengeId }),
      reason: `credential.source (${sourceMatch[1]}) does not match ${expectedLabel} (${expectedAddress})`,
    })
  }
}

/* -------------------------------------------------------------------------- */
/*  Best-effort terminal consume                                              */
/* -------------------------------------------------------------------------- */

/**
 * Mark a slot consumed after a settlement is already final on-chain,
 * retrying transient store failures, WITHOUT failing the verify.
 *
 * Once the payment is on-chain-final the payer must receive the receipt —
 * throwing here would report failure for a payment that happened. But a
 * swallowed markConsumed failure leaves the slot as plain `inflight`,
 * which `reserve()` reclaims after inflightTtlMs — re-opening the slot
 * for a second equal-priced challenge (double redemption on the shared
 * txhash keyspace). Retrying closes the transient-blip window; a
 * SUSTAINED store outage at exactly this moment remains a documented
 * residual risk (see docs/replay-store.md) that operators should alert
 * on via the warn below.
 *
 * Never throws.
 */
export async function consumeSlotBestEffort(
  store: ChargeStore,
  key: ReplayKey,
  /** Warn-label prefix, e.g. '[verifyPermit2]'. */
  label: string,
): Promise<void> {
  const delaysMs = [0, 200, 400]
  let lastErr: unknown
  for (const delay of delaysMs) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    try {
      await markConsumed(store, key)
      return
    } catch (err) {
      lastErr = err
    }
  }
  // eslint-disable-next-line no-console -- operator MUST alert on this: the
  // slot is settled on-chain but not terminally consumed in the store.
  console.warn(
    `${label} markConsumed failed after ${delaysMs.length} attempts; settlement is final ` +
      `on-chain but slot '${key}' remains inflight (reclaimable after inflightTtlMs). ` +
      'Returning the receipt anyway. Operator: mark the slot consumed manually. Error:',
    lastErr instanceof Error ? lastErr.message : String(lastErr),
  )
}
