/**
 * Challenge store for spec §8.0.1 stored-lookup challenge binding.
 *
 * The zero-deviation path from draft §6: server persists every issued
 * challenge by `challenge.id`, then re-serializes + constant-time compares
 * each auth-param field on credential verification.
 *
 * This is DIFFERENT from the replay store (`src/server/Replay.ts`):
 *
 *   - Replay store tracks SPENT credentials (consumed / rejected). Required
 *     regardless of challenge binding mode.
 *   - Challenge store tracks ISSUED challenges (presence + canonical bytes).
 *     Only required when `challengeBinding.mode === 'stored-lookup'`. mppx
 *     HMAC mode replaces it with a stateless HMAC over `(realm | method |
 *     intent | request | expires | digest | opaque)`.
 *
 * Item shape: the canonical wire-form bytes of each auth-param. Comparing
 * canonical bytes avoids the JS-object-deep-equality trap (key order, JCS
 * canonicalization, whitespace) that would silently allow tampering.
 *
 * Lifecycle (spec §8.0.1 stored challenge lifecycle):
 *   - `rememberChallenge(store, challenge)`: persist at issuance time.
 *   - `lookupChallenge(store, id)`: retrieve at verify time.
 *   - `forgetChallenge(store, id)`: cleanup after `Replay.markConsumed`
 *     completes OR after `challenge.expires` passes. Do NOT delete on
 *     first verify success — that would break legitimate retries after
 *     transient settlement failures.
 *
 * Production deployments MUST back this with a durable atomic store
 * (Redis / Postgres / Cloudflare KV) — `Store.memory()` is test/dev only.
 */

import { timingSafeEqual } from 'node:crypto'

import { type Challenge, PaymentRequest, type Store } from 'mppx'

/* -------------------------------------------------------------------------- */
/*  Item map + store type                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Canonical wire-form snapshot of a single issued challenge. Each field is
 * stored as the string the deployment originally put on the wire — the
 * comparison side derives the same form from the inbound credential.
 *
 *   - `request` is `PaymentRequest.serialize(challenge.request)` = base64url
 *     of the JCS-canonical JSON. Storing the canonical string (not the
 *     parsed object) eliminates JCS ordering disagreement at compare time.
 *   - `digest` / `opaque` are optional auth-param fields — present in the
 *     stored snapshot iff they were present at issuance.
 */
export interface StoredChallengeAuthParams {
  readonly id: string
  readonly realm: string
  readonly method: string
  readonly intent: string
  readonly request: string
  /**
   * Optional per mppx Challenge.Schema — deployments SHOULD always issue
   * with expires (otherwise the challenge can never be replay-protected
   * via Expires.assert). Stored verbatim when present; absent in stored
   * snapshot iff absent at issuance.
   */
  readonly expires?: string
  readonly digest?: string
  readonly opaque?: string
}

/**
 * Store item map. Indexed by `challenge.id`, valued with the canonical
 * auth-param snapshot.
 *
 * Plain `string` index signature satisfies mppx's
 * `Store.StoreItemMap = Record<string, unknown>` constraint; key narrowing
 * happens at the helper level (rememberChallenge / lookupChallenge /
 * forgetChallenge).
 */
export interface ChallengeItemMap {
  readonly [challengeId: string]: StoredChallengeAuthParams
}

/** Convenience alias — keeps the bound itemMap explicit at every callsite. */
export type ChallengeStore = Store.AtomicStore<ChallengeItemMap>

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Canonicalize a Challenge into the storage snapshot shape.
 *
 * Exported for testability + for deployments that want to compute the same
 * canonical form without going through the store (e.g. for audit logs).
 */
export function canonicalizeChallenge(challenge: Challenge.Challenge): StoredChallengeAuthParams {
  const snapshot: StoredChallengeAuthParams = {
    id: challenge.id,
    realm: challenge.realm,
    method: challenge.method,
    intent: challenge.intent,
    request: PaymentRequest.serialize(challenge.request),
    ...(challenge.expires !== undefined && { expires: challenge.expires }),
    ...(challenge.digest !== undefined && { digest: challenge.digest }),
    ...(challenge.opaque !== undefined && { opaque: challenge.opaque }),
  }
  return snapshot
}

/**
 * Persist an issued challenge by id. Idempotent: re-storing the same id
 * overwrites the snapshot (deliberate — re-issuing under the same id is
 * rare but legitimate when a server replays a challenge after a transient
 * persistence failure).
 *
 * MUST be called by the deployment at challenge issuance time (e.g. right
 * after `handler.challenge.evm.charge({...})` returns in stored-lookup
 * mode). The SDK provides this helper but does not auto-call it — mppx
 * does not expose an issuance hook.
 *
 * ⚠️ Unbounded growth (audit I02): anyone can trigger 402s for free, and
 * every one of them lands here. The SDK ships NO automatic sweep (the
 * store interface has no scan primitive), so the deployment MUST clean
 * up: call `forgetChallenge` once the matching replay slot is consumed,
 * AND give entries a backend TTL slightly past the challenge `expires`
 * (safe here — an expired challenge is rejected by `Expires.assert`
 * before the lookup ever runs; this is the opposite of REPLAY slots,
 * which must never expire). See docs/replay-store.md § “sweep the
 * stored-lookup challenge store”.
 */
export async function rememberChallenge(
  store: ChallengeStore,
  challenge: Challenge.Challenge,
): Promise<void> {
  const snapshot = canonicalizeChallenge(challenge)
  await store.update(challenge.id, () => ({
    op: 'set',
    value: snapshot,
    result: true as const,
  }))
}

/**
 * Look up the canonical snapshot for a given challenge id. Returns `null`
 * if the challenge was never issued (or was already forgotten).
 */
export async function lookupChallenge(
  store: ChallengeStore,
  challengeId: string,
): Promise<StoredChallengeAuthParams | null> {
  return store.get(challengeId)
}

/**
 * Drop a stored challenge — should be called after the corresponding
 * replay slot is marked `consumed`, or by a periodic sweep for expired
 * challenges (spec §8.0.1 lifecycle).
 */
export async function forgetChallenge(store: ChallengeStore, challengeId: string): Promise<void> {
  await store.update(challengeId, () => ({
    op: 'delete',
    result: true as const,
  }))
}

/* -------------------------------------------------------------------------- */
/*  Constant-time string equality                                             */
/* -------------------------------------------------------------------------- */

/**
 * Constant-time string equality. Returns `false` for length mismatch (still
 * runs a fixed-time `timingSafeEqual` call so the early-return does not
 * leak length difference via timing).
 *
 * Exposed for test introspection — production callers use it through the
 * field-by-field comparison in `verifyStoredLookup` (ChallengeBinding.ts).
 */
export function constantTimeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8')
  const bBuf = Buffer.from(b, 'utf8')
  if (aBuf.length !== bBuf.length) {
    // Pad to a common length so the actual compare still runs; the
    // outcome is forced false. Length leak is unavoidable in any
    // string-keyed lookup, so this is best-effort uniform-time.
    const len = Math.max(aBuf.length, bBuf.length, 1)
    const padA = Buffer.alloc(len)
    const padB = Buffer.alloc(len)
    aBuf.copy(padA)
    bBuf.copy(padB)
    // Force a deliberate mismatch by toggling one byte so the runtime
    // compare returns false even if both buffers happened to be all-zero.
    padB[0] = padA[0]! ^ 1
    timingSafeEqual(padA, padB)
    return false
  }
  return timingSafeEqual(aBuf, bBuf)
}
