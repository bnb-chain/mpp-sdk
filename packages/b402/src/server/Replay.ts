/**
 * Three-state replay guard for B402 settlement paths (audit H02).
 *
 * `/settle` is irreversible: once the facilitator broadcasts a transfer, a
 * second submission of the SAME credential must never be treated as a fresh
 * payment. The B402 facilitator's `/settle` may itself be idempotent on
 * resubmission (returning the same success envelope), which — without a
 * merchant-side guard — turns an ordinary client retry into N independent
 * "success" receipts for one on-chain payment.
 *
 * Every settlement-capable path reserves a slot BEFORE the first facilitator
 * call, then either:
 *
 *   - markConsumed   settlement provably succeeded (permanent)
 *   - markRejected   the credential is known-bad: facilitator verify said
 *                    invalid, payer mismatch (permanent — a fresh Challenge
 *                    issues a fresh nonce, so the payer is never wedged)
 *   - release        no facilitator settle was broadcast (transport error on
 *                    verify, or settle returned success=false with empty
 *                    transaction) — the slot frees for a clean retry
 *   - (leave inflight) settlement outcome is UNKNOWN (`B402SettlementUnknownError`)
 *                    — the transfer may already be on-chain, so the slot must
 *                    keep blocking retries until the stale-inflight TTL
 *                    reclaims it after the operator's reconciliation window
 *
 * Semantics mirror `@bnb-chain/mpp`'s `src/server/Replay.ts` (fencing token,
 * stale-inflight reclaim, write-once terminal states). The implementation is
 * duplicated rather than imported because the dependency direction is
 * one-way: b402 must stay standalone (ADR-0006) and depends on neither
 * `@bnb-chain/mpp` nor `mppx`.
 *
 * The store type below is STRUCTURAL on purpose: `mppx`'s
 * `Store.AtomicStore` (memory / redis / upstash / cloudflare) satisfies it
 * directly — `store: Store.memory()` typechecks with no cast. Production
 * deployments MUST use a durable atomic backend shared by all instances;
 * an in-memory store guards a single process only.
 */

/* -------------------------------------------------------------------------- */
/*  Slot + store typing                                                       */
/* -------------------------------------------------------------------------- */

export type B402ReplaySlotState = 'inflight' | 'consumed' | 'rejected'

export interface B402ReplaySlotValue {
  readonly state: B402ReplaySlotState
  /** Milliseconds since epoch when this state was written. */
  readonly ts: number
  /** Diagnostic only — populated for 'rejected' slots. */
  readonly reason?: string
  /**
   * Per-reservation fencing token, set while `inflight`. `release()` must
   * present it, so a stranded flow whose slot was TTL-reclaimed by a
   * successor cannot delete the successor's live slot. Absent on terminal
   * (`consumed` / `rejected`) slots.
   */
  readonly token?: string
}

/** Outcome of an atomic update callback — shape-compatible with mppx `Store.Change`. */
export type B402ReplayChange<result> =
  | { op: 'noop'; result: result }
  | { op: 'set'; value: B402ReplaySlotValue; result: result }
  | { op: 'delete'; result: result }

/**
 * Minimal atomic key-value contract the guard needs. `update` MUST be a
 * true atomic read-modify-write (CAS) — implementing it as a separate
 * `get` + `set` pair opens the exact TOCTOU double-settle window this
 * module exists to close. `mppx`'s `Store.AtomicStore` satisfies this type
 * structurally.
 */
export interface B402ReplayStore {
  get(key: string): Promise<unknown>
  update<result>(key: string, fn: (current: unknown) => B402ReplayChange<result>): Promise<result>
}

/** Namespaced key shape for every slot written by this module. */
export type B402ReplayKey = `bnb-b402:x402:exact:${string}`

/* -------------------------------------------------------------------------- */
/*  Normalized store error                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Thrown when the backing store rejects with anything other than a normal
 * CAS / lookup outcome, so callers can distinguish "another submission owns
 * the slot" (reserve returned `null`) from "backend down" (this error) and
 * operators get one class to alert on.
 */
export class B402ReplayStoreUnavailableError extends Error {
  override readonly name = 'B402ReplayStoreUnavailableError'
  readonly op: 'reserve' | 'markConsumed' | 'markRejected' | 'release' | 'get'
  readonly key: B402ReplayKey
  constructor(args: {
    op: 'reserve' | 'markConsumed' | 'markRejected' | 'release' | 'get'
    key: B402ReplayKey
    cause: unknown
  }) {
    const causeMsg = args.cause instanceof Error ? args.cause.message : String(args.cause)
    super(
      `B402 replay store '${args.op}' failed on key '${args.key}' — backend unavailable. ` +
        `Underlying: ${causeMsg}`,
      { cause: args.cause },
    )
    this.op = args.op
    this.key = args.key
  }
}

async function wrapUnavailable<T>(
  op: 'reserve' | 'markConsumed' | 'markRejected' | 'release' | 'get',
  key: B402ReplayKey,
  body: () => Promise<T>,
): Promise<T> {
  try {
    return await body()
  } catch (cause) {
    if (cause instanceof B402ReplayStoreUnavailableError) throw cause
    throw new B402ReplayStoreUnavailableError({ op, key, cause })
  }
}

/* -------------------------------------------------------------------------- */
/*  Key factory                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Replay key for a B402 exact-scheme credential.
 *
 * ⚠️ `payer` MUST be the locally recovered signer where a recover is
 *    possible (EOA signatures); for smart-account (ERC-1271) permit2
 *    signatures it is the declared `from`, which the facilitator's own
 *    on-chain `isValidSignature` check pins at verify/settle time.
 *
 * `transferMethod` separates the two nonce spaces (EIP-3009 nonces live in
 * each token contract; Permit2 nonces live in the Permit2 contract), and
 * `asset` keeps distinct tokens' EIP-3009 nonce spaces from colliding.
 * The nonce is canonicalized (bytes32 → lowercase, decimal → BigInt) so
 * re-encodings of one nonce cannot claim two slots.
 */
export function b402ReplayKey(parts: {
  readonly transferMethod: string
  readonly network: string
  readonly asset: string
  readonly payer: string
  readonly nonce: string
}): B402ReplayKey {
  const nonce = parts.nonce.startsWith('0x')
    ? parts.nonce.toLowerCase()
    : BigInt(parts.nonce).toString()
  return `bnb-b402:x402:exact:${parts.transferMethod}:${parts.network}:${parts.asset.toLowerCase()}:${parts.payer.toLowerCase()}:${nonce}`
}

/* -------------------------------------------------------------------------- */
/*  Atomic CAS primitives                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Default age after which a stale `inflight` slot is reclaimable — the
 * operator's window to reconcile a `B402SettlementUnknownError` before a
 * retry re-enters settlement. Matches the core package's default.
 */
export const B402_DEFAULT_INFLIGHT_TTL_MS = 10 * 60 * 1000

function asSlotValue(value: unknown): B402ReplaySlotValue | null {
  if (value === null || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (v['state'] !== 'inflight' && v['state'] !== 'consumed' && v['state'] !== 'rejected') {
    return null
  }
  if (typeof v['ts'] !== 'number') return null
  return value as B402ReplaySlotValue
}

/**
 * Atomically claim a slot. Returns the reservation's fencing token iff the
 * slot was free (now `inflight`); `null` on any existing state — inflight
 * (concurrent submission), consumed, rejected, or an unrecognized value
 * (fail closed: never overwrite data this module didn't write). A slot
 * stuck `inflight` longer than `inflightTtlMs` is reclaimed atomically with
 * a fresh token.
 */
export async function reserveB402Slot(
  store: B402ReplayStore,
  key: B402ReplayKey,
  opts?: { readonly inflightTtlMs?: number | undefined },
): Promise<string | null> {
  const inflightTtlMs = opts?.inflightTtlMs ?? B402_DEFAULT_INFLIGHT_TTL_MS
  const token = crypto.randomUUID()
  return wrapUnavailable('reserve', key, () =>
    store.update(key, (current) => {
      if (current !== null && current !== undefined) {
        const slot = asSlotValue(current)
        const stale =
          slot !== null && slot.state === 'inflight' && Date.now() - slot.ts >= inflightTtlMs
        if (!stale) return { op: 'noop', result: null }
        // fall through: reclaim the stale inflight slot with a FRESH token.
      }
      return { op: 'set', value: { state: 'inflight', ts: Date.now(), token }, result: token }
    }),
  )
}

/**
 * Mark a slot as successfully settled. Permanent, enforced by the CAS:
 * a slot already terminal is never overwritten (a late loser of a
 * stale-reclaim race cannot downgrade a settled payment).
 */
export async function markB402Consumed(store: B402ReplayStore, key: B402ReplayKey): Promise<void> {
  await wrapUnavailable('markConsumed', key, () =>
    store.update(key, (current) => {
      const slot = asSlotValue(current)
      if (
        current !== null &&
        current !== undefined &&
        (slot === null || slot.state !== 'inflight')
      ) {
        return { op: 'noop', result: false as const }
      }
      return { op: 'set', value: { state: 'consumed', ts: Date.now() }, result: true as const }
    }),
  )
}

/**
 * Mark a slot as known-bad. Permanent; the FIRST reason wins. Safe for the
 * payer: a fresh Challenge carries a fresh nonce, so rejecting one
 * credential never wedges future payments.
 */
export async function markB402Rejected(
  store: B402ReplayStore,
  key: B402ReplayKey,
  reason: string,
): Promise<void> {
  await wrapUnavailable('markRejected', key, () =>
    store.update(key, (current) => {
      const slot = asSlotValue(current)
      if (
        current !== null &&
        current !== undefined &&
        (slot === null || slot.state !== 'inflight')
      ) {
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
 * Free a slot for retry. Legal only while the slot is still `inflight` AND
 * owned by the caller (`token` from `reserveB402Slot`); anything else is a
 * noop, so a stranded flow can never delete a successor's live slot and a
 * post-`markRejected` safety-net release cannot un-reject a credential.
 */
export async function releaseB402Slot(
  store: B402ReplayStore,
  key: B402ReplayKey,
  token: string,
): Promise<void> {
  await wrapUnavailable('release', key, () =>
    store.update(key, (current) => {
      const slot = asSlotValue(current)
      if (slot === null || slot.state !== 'inflight' || slot.token !== token) {
        return { op: 'noop', result: false as const }
      }
      return { op: 'delete', result: true as const }
    }),
  )
}

/** Read the slot with backend-error normalization (`null` = genuinely empty). */
export async function getB402ReplaySlot(
  store: B402ReplayStore,
  key: B402ReplayKey,
): Promise<B402ReplaySlotValue | null> {
  return wrapUnavailable('get', key, async () => asSlotValue(await store.get(key)))
}

/* -------------------------------------------------------------------------- */
/*  Caller conveniences                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Diagnose why `reserveB402Slot` returned `null`, for an actionable error
 * message. `unknown` covers a raced delete or an unrecognized stored value.
 */
export async function describeB402ReplayConflict(
  store: B402ReplayStore,
  key: B402ReplayKey,
): Promise<{ state: B402ReplaySlotState | 'unknown'; reason?: string }> {
  const slot = await getB402ReplaySlot(store, key)
  if (slot === null) return { state: 'unknown' }
  return { state: slot.state, ...(slot.reason !== undefined ? { reason: slot.reason } : {}) }
}

/**
 * Mark consumed after a settlement is already final, retrying transient
 * store blips WITHOUT failing the caller — the payer must receive their
 * receipt once the facilitator settled. On sustained failure the slot stays
 * `inflight` (still blocking replays until the TTL) and a warning is
 * emitted for operator alerting.
 *
 * Never throws.
 */
export async function consumeB402SlotBestEffort(
  store: B402ReplayStore,
  key: B402ReplayKey,
  label: string,
): Promise<void> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await markB402Consumed(store, key)
      return
    } catch (err) {
      lastErr = err
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)))
    }
  }
  // eslint-disable-next-line no-console -- operator-facing alert; never fail a settled payment
  console.warn(
    `${label} markConsumed failed after retries on key '${key}' — slot stays inflight (replays ` +
      `still blocked until the reclaim TTL). Investigate the replay store. Underlying: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`,
  )
}
