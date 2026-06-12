/**
 * Three-state replay store for EVM Charge credentials (spec §9).
 *
 * The replay store is the SDK's atomic double-spend guard. Every verifier
 * (Permit2 / EIP-3009 / Transaction / Hash) reserves a slot at the start of
 * verification, then either:
 *
 *   - markConsumed   if the on-chain settlement succeeded AND Transfer logs
 *                    match the challenge (permanent — never retryable)
 *   - markRejected   if the credential is known-bad: reverted on-chain,
 *                    Transfer log mismatch, strict_from policy violation
 *                    (permanent by default; TTL allowed only for explicitly
 *                    documented low-risk pre-broadcast cases — NEVER for
 *                    on-chain-final evidence like nonce-consumed Permit2 /
 *                    EIP-3009 credentials or reverted txHash)
 *   - release        only valid when the slot is still `inflight` — used
 *                    when verification fails BEFORE on-chain state mutates
 *                    (signature invalid, deadline expired, etc.) so the
 *                    user can retry with a fresh credential
 *
 * `consumed` and `rejected` are distinct: `consumed` means a successful
 * payment settlement, `rejected` means the credential is known-bad and no
 * payment was extracted. The distinction matters for audit, refund /
 * chargeback reasoning, and operator monitoring (spec §9.1).
 *
 * Production deployments MUST back this with a durable atomic store
 * (Redis / Postgres / Cloudflare KV) — `Store.memory()` is test/dev only.
 * mppx HMAC challenge binding replaces the challenge store, NOT the replay
 * store (spec §1.3 / §9).
 */

import { Store } from 'mppx'
import type { Address, Hex } from 'viem'

/* -------------------------------------------------------------------------- */
/*  Normalized store error                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Thrown by `reserve` / `markConsumed` / `markRejected` / `release` /
 * `getReplaySlot` when the underlying `Store.AtomicStore.update` (or
 * `.get`, for `getReplaySlot`) rejects with anything other than a
 * normal CAS / lookup outcome.
 *
 * Previously the raw backend error (Redis `EHOSTUNREACH`, Postgres
 * `ECONNREFUSED`, Cloudflare KV throttle) propagated verbatim — verifier
 * safety-net `release()` calls would then ALSO call into the broken store
 * and throw a SECONDARY error that MASKED the original. Worse, callers
 * couldn't structurally distinguish "another inflight" (reserve returned
 * `false`) from "backend down" (reserve threw). This class makes
 * "backend unavailable" a first-class, catchable signal — verifiers can
 * surface a stable `VerificationFailedError` reason, and operator
 * monitoring can alert on `ReplayStoreUnavailableError` count.
 *
 * This also extends to the read path: `getReplaySlot(store, key)` is
 * the verifier-facing wrapper around `store.get`, and a backend failure
 * there also surfaces as `ReplayStoreUnavailableError({ op: 'get', ... })`
 * — operators get one error class to alert on regardless of which store
 * operation broke.
 *
 * The `cause` carries the original backend error for diagnostics.
 */
export class ReplayStoreUnavailableError extends Error {
  override readonly name = 'ReplayStoreUnavailableError'
  /** Which primitive failed — useful for operator logs. */
  readonly op: 'reserve' | 'markConsumed' | 'markRejected' | 'release' | 'get'
  /** Replay key being operated on, for log correlation. */
  readonly key: ReplayKey
  constructor(args: {
    op: 'reserve' | 'markConsumed' | 'markRejected' | 'release' | 'get'
    key: ReplayKey
    cause: unknown
  }) {
    const causeMsg = args.cause instanceof Error ? args.cause.message : String(args.cause)
    super(
      `Replay store '${args.op}' failed on key '${args.key}' — backend unavailable. ` +
        `Underlying: ${causeMsg}`,
      { cause: args.cause },
    )
    this.op = args.op
    this.key = args.key
  }
}

/**
 * Internal wrapper that normalizes any backend throw into
 * `ReplayStoreUnavailableError`. Use for the four CAS primitives AND
 * for `getReplaySlot` so verifiers never see a raw backend
 * error regardless of which method they touched.
 */
async function withStoreUnavailableWrap<T>(
  op: 'reserve' | 'markConsumed' | 'markRejected' | 'release' | 'get',
  key: ReplayKey,
  body: () => Promise<T>,
): Promise<T> {
  try {
    return await body()
  } catch (cause) {
    // Don't double-wrap if a nested call already normalized.
    if (cause instanceof ReplayStoreUnavailableError) throw cause
    throw new ReplayStoreUnavailableError({ op, key, cause })
  }
}

/* -------------------------------------------------------------------------- */
/*  Slot state                                                                */
/* -------------------------------------------------------------------------- */

export type ReplaySlotState = 'inflight' | 'consumed' | 'rejected'

export interface ReplaySlotValue {
  readonly state: ReplaySlotState
  /** Milliseconds since epoch when this state was written. */
  readonly ts: number
  /** Diagnostic only — populated for 'rejected' slots. */
  readonly reason?: string
}

/* -------------------------------------------------------------------------- */
/*  Store typing                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Key shape for every replay slot. Templated `${prefix}:evm:charge:${...}`
 * to keep the EVM Charge namespace isolated from other intents sharing the
 * same backing store. Enforced by the key-factory return types (permit2Key,
 * authKey, txHashKey) — every key flowing through the store APIs goes
 * through one of those factories.
 */
export type ReplayKey = `${string}:evm:charge:${string}`

/**
 * Item map declared with a plain `string` index signature so the type
 * satisfies mppx's `Store.StoreItemMap = Record<string, unknown>` constraint.
 * The actual key narrowing happens at the factory level via `ReplayKey`.
 */
export interface ReplayItemMap {
  readonly [key: string]: ReplaySlotValue
}

/** Convenience alias — keeps the bound itemMap explicit at every callsite. */
export type ChargeStore = Store.AtomicStore<ReplayItemMap>

/* -------------------------------------------------------------------------- */
/*  Atomic CAS primitives                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Default age after which a stale `inflight` slot becomes reclaimable by
 * a new `reserve()`. Comfortably above viem's 180s receipt-wait default
 * plus worst-case mining delay on the curated chains.
 */
export const DEFAULT_INFLIGHT_TTL_MS = 10 * 60 * 1000

/**
 * Atomically claim a replay slot.
 *
 * Returns `true` iff the slot was free (and is now `inflight`); `false` if
 * any prior state is present (inflight from a concurrent verify, consumed
 * from a successful settlement, or rejected from a known-bad credential).
 *
 * Stale-inflight reclaim: a crash, receipt-wait timeout, or severed
 * connection can strand a slot in `inflight`. Without recovery, every
 * retry would fail "concurrent verify in progress" forever. A slot whose
 * `ts` is older than `inflightTtlMs` (default 10min) is therefore
 * reclaimed — atomically, inside the same CAS — and the retry re-enters
 * verification. This is safe because every verifier re-checks on-chain
 * state after reserve (nonce consumption / receipt lookups), so a
 * settlement that DID land while the slot was stranded is detected
 * rather than double-executed. Terminal states (consumed / rejected) are
 * NEVER reclaimed.
 *
 * MUST be implemented via `store.update` — never a separate `has` + `set`
 * pair (spec §9.3: that opens a TOCTOU double-spend window).
 */
export async function reserve(
  store: ChargeStore,
  key: ReplayKey,
  opts?: { readonly inflightTtlMs?: number | undefined },
): Promise<boolean> {
  const inflightTtlMs = opts?.inflightTtlMs ?? DEFAULT_INFLIGHT_TTL_MS
  return withStoreUnavailableWrap('reserve', key, () =>
    store.update(key, (current) => {
      if (current !== null) {
        const stale = current.state === 'inflight' && Date.now() - current.ts >= inflightTtlMs
        if (!stale) return { op: 'noop', result: false }
        // fall through: reclaim the stale inflight slot
      }
      return { op: 'set', value: { state: 'inflight', ts: Date.now() }, result: true }
    }),
  )
}

/**
 * Mark a reserved slot as successfully settled. Permanent — and the
 * permanence is enforced by the CAS itself: a slot already in a terminal
 * state (`consumed` / `rejected`) is never overwritten. After a
 * stale-inflight reclaim race two flows can each believe they own the
 * slot; without this guard the loser's late `markRejected` could
 * downgrade a settled payment (or this call could flip a `rejected`
 * verdict to `consumed`). Re-marking the same terminal state is a
 * harmless noop — the existing value (and its `ts`) is kept.
 */
export async function markConsumed(store: ChargeStore, key: ReplayKey): Promise<void> {
  await withStoreUnavailableWrap('markConsumed', key, () =>
    store.update(key, (current) => {
      if (current !== null && current.state !== 'inflight') {
        // Terminal states are write-once — keep the existing value.
        return { op: 'noop', result: false as const }
      }
      return {
        op: 'set',
        value: { state: 'consumed', ts: Date.now() },
        result: true as const,
      }
    }),
  )
}

/**
 * Mark a reserved slot as known-bad with a diagnostic reason. Permanent
 * unless an operator policy explicitly documents TTL-based cleanup for the
 * pre-broadcast case (see file header). Like `markConsumed`, the
 * permanence is enforced by the CAS itself: a slot already in a terminal
 * state (`consumed` / `rejected`) is never overwritten — a late loser of
 * a stale-inflight reclaim race cannot downgrade a `consumed` slot, and
 * re-marking an already-`rejected` slot keeps the FIRST reason (and `ts`).
 */
export async function markRejected(
  store: ChargeStore,
  key: ReplayKey,
  reason: string,
): Promise<void> {
  await withStoreUnavailableWrap('markRejected', key, () =>
    store.update(key, (current) => {
      if (current !== null && current.state !== 'inflight') {
        // Terminal states are write-once — keep the existing value.
        return { op: 'noop', result: false as const }
      }
      return {
        op: 'set',
        value: { state: 'rejected', ts: Date.now(), reason },
        result: true as const,
      }
    }),
  )
}

/**
 * Release a slot back to the free state. Only legal when the slot is still
 * `inflight` (verification failed before any on-chain mutation). Calling
 * release on a `consumed` or `rejected` slot is a noop — those are permanent.
 */
export async function release(store: ChargeStore, key: ReplayKey): Promise<void> {
  await withStoreUnavailableWrap('release', key, () =>
    store.update(key, (current) => {
      if (current === null || current.state !== 'inflight') {
        return { op: 'noop', result: false as const }
      }
      return { op: 'delete', result: true as const }
    }),
  )
}

/**
 * Read the current slot state with backend-error normalization.
 *
 * Verifiers call this AFTER `reserve()` returns `false` to diagnose
 * which terminal state the slot landed in (consumed / rejected) so
 * the user-facing error message is actionable. Previously each verifier
 * called raw `store.get(key)`; a backend failure there leaked the raw
 * Redis / Postgres error verbatim — inconsistent with the
 * ReplayStoreUnavailableError normalization on the four CAS primitives.
 *
 * This helper closes that gap: any backend throw from `.get` is
 * re-thrown as `ReplayStoreUnavailableError({ op: 'get', key, cause })`.
 *
 * Returns `null` when the slot is genuinely empty (vs. backend failure).
 */
export async function getReplaySlot(
  store: ChargeStore,
  key: ReplayKey,
): Promise<ReplaySlotValue | null> {
  return withStoreUnavailableWrap('get', key, () => store.get(key))
}

/* -------------------------------------------------------------------------- */
/*  Key factories                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Namespace prefix for every key written through this module. Keeps the
 * EVM Charge replay namespace isolated from other mppx intents that might
 * share the backing store.
 */
const NAMESPACE = 'bnb-mpp' as const

/**
 * Replay key for a Permit2 credential.
 *
 * ⚠️ `signer` MUST come from `viem.verifyTypedData` recovery — never from
 *    the credential payload's stated identity. A forged payload could
 *    otherwise collide on a victim's key.
 *
 * ⚠️ `permit2Address` is REQUIRED: a self-deployed / fork Permit2 has
 *    its own nonce space, distinct from the canonical Permit2's. Omitting
 *    the address would let identical `(chainId, signer, nonce)` collide
 *    across deployments and silently cross-spend.
 *
 * All address inputs are lowercased so wire / verifier comparisons match
 * regardless of EIP-55 casing.
 */
export function permit2Key(
  chainId: number,
  permit2Address: Address,
  signer: Address,
  nonce: string,
): ReplayKey {
  // Canonicalize via BigInt: the EIP-712 message hashes BigInt(nonce), so
  // "1" and "01" carry the identical signature. Keying on the raw wire
  // string would give re-encodings of the same nonce distinct slots —
  // concurrent submissions of both would each pass reserve() and
  // double-broadcast the settlement.
  return `${NAMESPACE}:evm:charge:permit2:${chainId}:${permit2Address.toLowerCase()}:${signer.toLowerCase()}:${BigInt(nonce).toString()}`
}

/**
 * Replay key for an EIP-3009 authorization credential.
 *
 * ⚠️ `token` is REQUIRED: EIP-3009 nonce state lives inside each token
 *    contract (`authorizationState(authorizer, nonce)`), so the same
 *    `(chainId, signer, nonce)` is independent across token contracts.
 *    Omitting `token` would collapse different tokens' nonce spaces.
 *
 * ⚠️ `from` is the signer recovered via `verifyTypedData`, NOT the
 *    payload's stated `from` field.
 */
export function authKey(chainId: number, token: Address, from: Address, nonce: Hex): ReplayKey {
  return `${NAMESPACE}:evm:charge:auth:${chainId}:${token.toLowerCase()}:${from.toLowerCase()}:${nonce.toLowerCase()}`
}

/**
 * Replay key for an on-chain transaction hash — shared by `transaction`
 * AND `hash` credentials.
 *
 * Spec §8 defines the SAME replay token for both credential types: the
 * transaction hash. They MUST share one keyspace — a transfer settled via
 * a `transaction` credential must not be redeemable again as a `hash`
 * credential for a second equal-priced challenge (or vice versa). Keying
 * by credential type would split that single token into two independent
 * slots and let one on-chain transfer settle two charges.
 */
export function txHashKey(chainId: number, txHash: Hex): ReplayKey {
  return `${NAMESPACE}:evm:charge:txhash:${chainId}:${txHash.toLowerCase()}`
}
