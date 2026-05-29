/**
 * Challenge binding helpers (spec §8.0).
 *
 * Every verifier (Permit2 / EIP-3009 / Transaction / Hash) calls a
 * `verifyChallengeBinding` helper before doing any on-chain work. The
 * helper enforces three things at minimum:
 *
 *   1. method  === 'evm'
 *   2. intent  === 'charge'
 *   3. challenge.id integrity (per binding mode)
 *
 * Three binding modes are configurable on `ServerParameters.challengeBinding`:
 *
 *   - 'mppx-managed'  — deployment uses Mppx.create()'s HTTP entry. mppx
 *                       automatically runs Challenge.verify + Expires.assert
 *                       (src/server/Mppx.ts L518/L535/L1033/L1110), so the
 *                       SDK helper only runs the method/intent guard.
 *
 *   - 'mppx-hmac'     — deployment does NOT use Mppx.create(). The SDK
 *                       helper calls Challenge.verify({ secretKey }) +
 *                       Expires.assert directly.
 *
 *   - 'stored-lookup' — draft §6 zero-deviation: server persists every
 *                       issued challenge into a `ChallengeStore`, then
 *                       on verify re-derives the canonical wire form of
 *                       each auth-param field and constant-time compares
 *                       to the stored snapshot. Ships the helper +
 *                       a memory backend (test/dev only); production
 *                       deployments wire in a durable backend (Redis /
 *                       Postgres / Cloudflare KV).
 *
 * The deployment's chosen mode MUST appear in the README "Spec Compliance"
 * section. Choice cannot be changed at runtime — the helper is closed over
 * the config at server-factory construction time.
 */

import { Challenge, type Credential, Errors, Expires, PaymentRequest } from 'mppx'

import { type ChallengeStore, constantTimeStringEqual, lookupChallenge } from './ChallengeStore.js'

/* -------------------------------------------------------------------------- */
/*  Config                                                                    */
/* -------------------------------------------------------------------------- */

export type ChallengeBindingConfig =
  | { readonly mode: 'mppx-managed' }
  | { readonly mode: 'mppx-hmac'; readonly secretKey: string }
  | { readonly mode: 'stored-lookup'; readonly challengeStore: ChallengeStore }

/* -------------------------------------------------------------------------- */
/*  Helper factory                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Per-server challenge binding verifier.
 *
 * Receives the inbound credential AND the route-time request (already
 * merged: server-factory defaults + route options + Charge.ts request
 * hook normalisation). Modes other than mppx-managed compare the route
 * request to `credential.challenge.request` byte-for-byte via
 * `PaymentRequest.serialize` — this catches mismatches that an
 * HMAC-free or stored-lookup deployment would otherwise miss.
 */
export type VerifyChallengeBindingFn = (
  credential: Credential.Credential,
  request: Record<string, unknown>,
) => Promise<void>

/**
 * Produce the per-server `verifyChallengeBinding` helper.
 *
 * Capture the mode + secret / store at construction so the verify-time call
 * site has no opportunity to override — eliminates an entire class of
 * "wrong mode was used" misconfiguration bugs.
 */
export function makeVerifyChallengeBinding(
  config: ChallengeBindingConfig,
): VerifyChallengeBindingFn {
  switch (config.mode) {
    case 'mppx-managed':
      return (credential, _request) => verifyMppxManaged(credential)
    case 'mppx-hmac': {
      const { secretKey } = config
      return (credential, request) => verifyMppxHmac(credential, secretKey, request)
    }
    case 'stored-lookup': {
      const { challengeStore } = config
      return (credential, request) => verifyStoredLookup(credential, challengeStore, request)
    }
  }
}

/**
 * Byte-level comparison of two PaymentRequest objects via the canonical
 * `PaymentRequest.serialize` (base64url-JCS) form. Used by mppx-hmac and
 * stored-lookup modes to ensure the route's request matches what the
 * challenge was issued for (i.e. defenders against route options that
 * try to override server-configured values like currency / recipient /
 * methodDetails). mppx-managed mode delegates this to the framework's
 * own HMAC verification.
 */
function assertRouteRequestMatchesChallenge(
  challengeRequest: Record<string, unknown>,
  routeRequest: Record<string, unknown>,
  challengeId?: string,
): void {
  const challengeForm = PaymentRequest.serialize(challengeRequest)
  const routeForm = PaymentRequest.serialize(routeRequest)
  if (challengeForm !== routeForm) {
    throw new Errors.InvalidChallengeError({
      ...(challengeId && { id: challengeId }),
      reason:
        'verifyChallengeBinding: route request does not match challenge.request — ' +
        'a route option is attempting to override a server-configured value',
    })
  }
}

/* -------------------------------------------------------------------------- */
/*  Mode implementations                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Shared method + intent guard. Runs in every mode — even mppx-managed,
 * because nothing about Mppx.create's HMAC verification proves that the
 * credential targets the EVM Charge method (a malicious peer could craft
 * a credential bound to a different method id but signed by the same HMAC
 * if mppx ever loosened method discrimination).
 */
function assertEvmCharge(credential: Credential.Credential): void {
  const { method, intent, id } = credential.challenge
  if (method !== 'evm') {
    throw new Errors.InvalidChallengeError({
      ...(id && { id }),
      reason: `expected method='evm', got '${method}'`,
    })
  }
  if (intent !== 'charge') {
    throw new Errors.InvalidChallengeError({
      ...(id && { id }),
      reason: `expected intent='charge', got '${intent}'`,
    })
  }
}

/** mppx-managed: only method/intent. HMAC + Expires done by Mppx.create. */
async function verifyMppxManaged(credential: Credential.Credential): Promise<void> {
  assertEvmCharge(credential)
}

/**
 * mppx-hmac: SDK runs the full Challenge.verify + Expires.assert chain
 * because the deployment doesn't go through Mppx.create's HTTP pipeline.
 * Plus: route request must byte-equal challenge.request — without this
 * comparison, the bare-verify path would miss route override attempts
 * (the HMAC only binds the issued challenge to itself, not to a future
 * verify-time request).
 */
async function verifyMppxHmac(
  credential: Credential.Credential,
  secretKey: string,
  request: Record<string, unknown>,
): Promise<void> {
  assertEvmCharge(credential)
  const { challenge } = credential

  // Challenge.verify returns boolean (does NOT throw). Throw a normalized
  // InvalidChallengeError so all binding modes report the same error class.
  const ok = Challenge.verify(challenge, { secretKey })
  if (!ok) {
    throw new Errors.InvalidChallengeError({
      ...(challenge.id && { id: challenge.id }),
      reason: 'HMAC mismatch',
    })
  }

  // Expires.assert throws InvalidChallengeError on missing/malformed/expired.
  Expires.assert(challenge.expires, challenge.id)

  // Defence: route request must match the request that issued the challenge.
  assertRouteRequestMatchesChallenge(challenge.request, request, challenge.id)
}

/**
 * stored-lookup: draft §6 zero-deviation path.
 *
 * Sequence (spec §8.0.1):
 *   1. method/intent guard (assertEvmCharge).
 *   2. Expires.assert — bail before any storage hit if the challenge has
 *      already expired (cheap-reject ordering).
 *   3. lookupChallenge by id. Missing → reject as forged/unknown.
 *   4. Field-by-field constant-time compare between the stored snapshot
 *      and the canonical wire form derived from credential.challenge:
 *        - request:                PaymentRequest.serialize(challenge.request)
 *        - realm / method / intent / expires:  direct string compare
 *        - digest / opaque:        present-iff-stored AND value equal
 *   5. Any mismatch → InvalidChallengeError (reason names the field, no
 *      value leak in the message).
 *
 * NOT performed here: HMAC verification — stored-lookup intentionally
 * does not depend on Challenge.verify({ secretKey }), so the deployment
 * can run completely without a server secret. (Combining stored-lookup
 * with Mppx.create's auto-HMAC layer yields a stricter-than-spec
 * double-check; that combination is acceptable but adds latency. See
 * spec §8.0.2.1.)
 */
async function verifyStoredLookup(
  credential: Credential.Credential,
  challengeStore: ChallengeStore,
  request: Record<string, unknown>,
): Promise<void> {
  assertEvmCharge(credential)
  const { challenge } = credential

  Expires.assert(challenge.expires, challenge.id)

  // Defence: route request must match the request the challenge was
  // issued for. (The stored snapshot below redundantly confirms the
  // SAME relationship via canonical bytes; this check is the early-fail
  // path that matches mppx-hmac's behaviour.)
  assertRouteRequestMatchesChallenge(challenge.request, request, challenge.id)

  const stored = await lookupChallenge(challengeStore, challenge.id)
  if (stored === null) {
    throw new Errors.InvalidChallengeError({
      ...(challenge.id && { id: challenge.id }),
      reason: 'stored-lookup: challenge id is not in the issued-challenges store',
    })
  }

  // Re-derive canonical wire form of request from the (parsed) credential
  // challenge, then byte-compare to the stored snapshot. This is the
  // key step spec §8.0.1 calls out — comparing the parsed objects
  // directly would always mismatch or accept wrong tampered variants.
  const requestSerialized = PaymentRequest.serialize(challenge.request)

  type StringField = 'request' | 'realm' | 'method' | 'intent'
  const pairs: ReadonlyArray<readonly [StringField, string, string]> = [
    ['request', stored.request, requestSerialized],
    ['realm', stored.realm, challenge.realm],
    ['method', stored.method, challenge.method],
    ['intent', stored.intent, challenge.intent],
  ]
  for (const [name, storedValue, candidate] of pairs) {
    if (!constantTimeStringEqual(storedValue, candidate)) {
      throw new Errors.InvalidChallengeError({
        ...(challenge.id && { id: challenge.id }),
        reason: `stored-lookup: '${name}' does not match stored snapshot`,
      })
    }
  }

  // Optional auth-params: presence MUST match too (storing them and
  // omitting on verify, or vice-versa, is a tamper). `expires` is in
  // this group because mppx Challenge.Schema marks it z.optional —
  // Expires.assert above has already enforced presence + freshness when
  // it was supplied on the credential.
  type OptionalField = 'expires' | 'digest' | 'opaque'
  const optionalPairs: ReadonlyArray<
    readonly [OptionalField, string | undefined, string | undefined]
  > = [
    ['expires', stored.expires, challenge.expires],
    ['digest', stored.digest, challenge.digest],
    ['opaque', stored.opaque, challenge.opaque],
  ]
  for (const [name, storedValue, candidate] of optionalPairs) {
    if ((storedValue === undefined) !== (candidate === undefined)) {
      throw new Errors.InvalidChallengeError({
        ...(challenge.id && { id: challenge.id }),
        reason: `stored-lookup: '${name}' presence does not match stored snapshot`,
      })
    }
    if (
      storedValue !== undefined &&
      candidate !== undefined &&
      !constantTimeStringEqual(storedValue, candidate)
    ) {
      throw new Errors.InvalidChallengeError({
        ...(challenge.id && { id: challenge.id }),
        reason: `stored-lookup: '${name}' does not match stored snapshot`,
      })
    }
  }
}
