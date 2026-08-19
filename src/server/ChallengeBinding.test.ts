/**
 * Challenge binding helper invariants (spec §8.0, stored-lookup live).
 *
 * The helper returned by makeVerifyChallengeBinding() is the gate every
 * verifier passes through before touching chain state. Tests cover:
 *
 *   - method/intent guard fires in all three modes (mppx-managed,
 *     mppx-hmac, stored-lookup)
 *   - mppx-hmac fails on HMAC mismatch + on expired/malformed expires
 *   - mppx-managed accepts the same credential that mppx-hmac would
 *     accept (proof that mppx-managed is intentionally permissive at
 *     the SDK layer; deployment relies on Mppx.create to enforce HMAC)
 *   - stored-lookup: accepts a remembered challenge, rejects on
 *     missing id / request tamper / realm tamper / digest tamper /
 *     opaque presence mismatch / expired challenge.
 */

import { Challenge, type Credential, Errors, Store } from 'mppx'
import { describe, expect, test } from 'vitest'

import { type ChallengeBindingConfig, makeVerifyChallengeBinding } from './ChallengeBinding.js'
import { type ChallengeStore, rememberChallenge } from './ChallengeStore.js'

const SECRET = 'test-secret-do-not-use-in-prod-at-least-32' as const

const MINIMAL_REQUEST = {
  amount: '1000000',
  currency: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  recipient: '0x2222222222222222222222222222222222222222',
  methodDetails: {
    chainId: 1,
    permit2Address: '0x000000000022d473030f116ddee9f6b43ac78ba3',
  },
} as const

/** Build a Challenge with a real HMAC id via mppx Challenge.from. */
function buildValidChallenge(
  overrides: { method?: string; intent?: string; expires?: string } = {},
): Challenge.Challenge {
  return Challenge.from({
    method: overrides.method ?? 'evm',
    intent: overrides.intent ?? 'charge',
    realm: 'https://api.example.com/',
    request: MINIMAL_REQUEST,
    expires: overrides.expires ?? new Date(Date.now() + 60_000).toISOString(),
    secretKey: SECRET,
  })
}

const wrapCred = (challenge: Challenge.Challenge): Credential.Credential => ({
  challenge,
  payload: { type: 'hash', hash: '0x'.padEnd(66, 'a') },
})

/**
 * Test helper — calls `verifyChallengeBinding(cred, request)` with the
 * challenge's own request as the route request (the natural matching
 * case). Used as `verify(...pair(challenge))` throughout this file so the
 * call site stays a single line.
 */
function pair(challenge: Challenge.Challenge): [Credential.Credential, Record<string, unknown>] {
  const cred = wrapCred(challenge)
  return [cred, cred.challenge.request as Record<string, unknown>]
}

/* -------------------------------------------------------------------------- */
/*  Method / intent guard (all modes)                                         */
/* -------------------------------------------------------------------------- */

/** Build a fresh memory-backed ChallengeStore per test (no cross-test bleed). */
function freshChallengeStore(): ChallengeStore {
  return Store.memory() as unknown as ChallengeStore
}

const MODES: ChallengeBindingConfig[] = [
  { mode: 'mppx-managed' },
  { mode: 'mppx-hmac', secretKey: SECRET },
  // For the method/intent guard tests we don't need a populated store — the
  // guard runs before lookup. A throwaway memory store is fine.
  { mode: 'stored-lookup', challengeStore: freshChallengeStore() },
]

describe('method / intent guard fires in all three modes', () => {
  test.each(MODES)('mode=$mode rejects method != evm', async (config) => {
    const verify = makeVerifyChallengeBinding(config)
    const cred = wrapCred(buildValidChallenge({ method: 'tempo' }))
    await expect(verify(cred, cred.challenge.request as Record<string, unknown>)).rejects.toThrow(
      /method.*evm/,
    )
  })

  test.each(MODES)('mode=$mode rejects intent != charge', async (config) => {
    const verify = makeVerifyChallengeBinding(config)
    const cred = wrapCred(buildValidChallenge({ intent: 'session' }))
    await expect(verify(cred, cred.challenge.request as Record<string, unknown>)).rejects.toThrow(
      /intent.*charge/,
    )
  })

  test.each(MODES)('mode=$mode throws InvalidChallengeError class', async (config) => {
    const verify = makeVerifyChallengeBinding(config)
    const cred = wrapCred(buildValidChallenge({ method: 'tempo' }))
    await expect(
      verify(cred, cred.challenge.request as Record<string, unknown>),
    ).rejects.toBeInstanceOf(Errors.InvalidChallengeError)
  })
})

/* -------------------------------------------------------------------------- */
/*  mppx-managed: permissive beyond method/intent                             */
/* -------------------------------------------------------------------------- */

describe('mppx-managed mode (mppx Mppx.create handles HMAC + Expires)', () => {
  const verify = makeVerifyChallengeBinding({ mode: 'mppx-managed' })

  test('accepts valid credential', async () => {
    await expect(verify(...pair(buildValidChallenge()))).resolves.toBeUndefined()
  })

  test('accepts even when expires is missing (mppx is the gate, not SDK)', async () => {
    const challenge = buildValidChallenge()
    const tampered = { ...challenge, expires: undefined } as Challenge.Challenge
    await expect(verify(...pair(tampered))).resolves.toBeUndefined()
  })

  test('accepts even when HMAC is broken (mppx is the gate, not SDK)', async () => {
    const challenge = buildValidChallenge()
    const tampered = { ...challenge, id: 'forged-id' } as Challenge.Challenge
    await expect(verify(...pair(tampered))).resolves.toBeUndefined()
  })
})

/* -------------------------------------------------------------------------- */
/*  mppx-hmac: full Challenge.verify + Expires.assert                         */
/* -------------------------------------------------------------------------- */

describe('mppx-hmac mode (bare verify path)', () => {
  const verify = makeVerifyChallengeBinding({ mode: 'mppx-hmac', secretKey: SECRET })

  test('accepts a valid credential issued under the same secret', async () => {
    await expect(verify(...pair(buildValidChallenge()))).resolves.toBeUndefined()
  })

  test('rejects with HMAC mismatch when id is forged', async () => {
    const challenge = buildValidChallenge()
    const tampered = { ...challenge, id: 'forged-id' } as Challenge.Challenge
    await expect(verify(...pair(tampered))).rejects.toThrow(/HMAC mismatch/)
  })

  test('rejects with HMAC mismatch when realm is tampered', async () => {
    const challenge = buildValidChallenge()
    const tampered = { ...challenge, realm: 'https://attacker.example.com/' } as Challenge.Challenge
    await expect(verify(...pair(tampered))).rejects.toThrow(/HMAC mismatch/)
  })

  test('rejects with HMAC mismatch when request fields are tampered', async () => {
    const challenge = buildValidChallenge()
    const tampered = {
      ...challenge,
      request: { ...challenge.request, amount: '999' },
    } as Challenge.Challenge
    await expect(verify(...pair(tampered))).rejects.toThrow(/HMAC mismatch/)
  })

  test('rejects with missing expires', async () => {
    // Build under same SECRET so HMAC passes, but with expires undefined.
    const challenge = Challenge.from({
      method: 'evm',
      intent: 'charge',
      realm: 'https://api.example.com/',
      request: MINIMAL_REQUEST,
      secretKey: SECRET,
    })
    await expect(verify(...pair(challenge))).rejects.toThrow(/expires/)
  })

  test('rejects on expired challenge', async () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    await expect(verify(...pair(buildValidChallenge({ expires: past })))).rejects.toThrow()
  })

  // Audit M04: Expires.assert (cheap) must run BEFORE Challenge.verify
  // (canonicalize + HMAC, cost scales with attacker-controlled request
  // size). An expired forgery must fail on expiry, never buy the HMAC step.
  test('checks expiry before HMAC (cheap-reject ordering)', async () => {
    // Tampered id → HMAC would mismatch; also expired. The expiry check
    // runs first, so the error is about expiry, not HMAC.
    const past = new Date(Date.now() - 60_000).toISOString()
    const challenge = buildValidChallenge({ expires: past })
    const tampered = { ...challenge, id: 'forged-id' } as Challenge.Challenge
    await expect(verify(...pair(tampered))).rejects.toThrow(/expire/i)
  })

  test('rejects when route request differs from challenge.request', async () => {
    const challenge = buildValidChallenge()
    const cred = wrapCred(challenge)
    const routeRequest = {
      ...(cred.challenge.request as Record<string, unknown>),
      amount: '999999999', // differs from challenge.request.amount
    }
    await expect(verify(cred, routeRequest)).rejects.toThrow(/route request does not match/)
  })
})

/* -------------------------------------------------------------------------- */
/*  stored-lookup: live implementation (spec §8.0.1)                          */
/* -------------------------------------------------------------------------- */

describe('stored-lookup mode (draft §6 zero-deviation)', () => {
  test('accepts a remembered challenge (happy path)', async () => {
    const challengeStore = freshChallengeStore()
    const challenge = buildValidChallenge()
    await rememberChallenge(challengeStore, challenge)
    const verify = makeVerifyChallengeBinding({ mode: 'stored-lookup', challengeStore })

    await expect(verify(...pair(challenge))).resolves.toBeUndefined()
  })

  test('rejects when challenge id was never remembered', async () => {
    const challengeStore = freshChallengeStore()
    // Skip rememberChallenge → store is empty
    const verify = makeVerifyChallengeBinding({ mode: 'stored-lookup', challengeStore })

    await expect(verify(...pair(buildValidChallenge()))).rejects.toThrow(/not in the issued/)
  })

  // Audit M04: the id-existence lookup (cheap key read) must run BEFORE the
  // route-request canonicalization (RFC 8785, scales with attacker bytes).
  // An unknown id paired with a mismatching route request fails on the
  // lookup, never on the expensive comparison.
  test('checks id existence before canonicalizing the route request', async () => {
    const challengeStore = freshChallengeStore() // empty
    const verify = makeVerifyChallengeBinding({ mode: 'stored-lookup', challengeStore })
    const cred = wrapCred(buildValidChallenge())
    const mismatchingRoute = {
      ...(cred.challenge.request as Record<string, unknown>),
      amount: '999999999',
    }
    await expect(verify(cred, mismatchingRoute)).rejects.toThrow(/not in the issued/)
  })

  test('rejects when request fields are tampered after remember', async () => {
    const challengeStore = freshChallengeStore()
    const challenge = buildValidChallenge()
    await rememberChallenge(challengeStore, challenge)
    const verify = makeVerifyChallengeBinding({ mode: 'stored-lookup', challengeStore })

    const tampered = {
      ...challenge,
      request: { ...challenge.request, amount: '999' },
    } as Challenge.Challenge
    await expect(verify(...pair(tampered))).rejects.toThrow(/'request' does not match/)
  })

  test('rejects when realm is tampered', async () => {
    const challengeStore = freshChallengeStore()
    const challenge = buildValidChallenge()
    await rememberChallenge(challengeStore, challenge)
    const verify = makeVerifyChallengeBinding({ mode: 'stored-lookup', challengeStore })

    const tampered = { ...challenge, realm: 'https://attacker.example.com/' } as Challenge.Challenge
    await expect(verify(...pair(tampered))).rejects.toThrow(/'realm' does not match/)
  })

  test('rejects when expires is tampered (different value than stored)', async () => {
    const challengeStore = freshChallengeStore()
    const challenge = buildValidChallenge()
    await rememberChallenge(challengeStore, challenge)
    const verify = makeVerifyChallengeBinding({ mode: 'stored-lookup', challengeStore })

    const future = new Date(Date.now() + 600_000).toISOString()
    const tampered = { ...challenge, expires: future } as Challenge.Challenge
    await expect(verify(...pair(tampered))).rejects.toThrow(/'expires' does not match/)
  })

  test('rejects expired challenge before storage lookup', async () => {
    const challengeStore = freshChallengeStore()
    const expired = buildValidChallenge({ expires: new Date(Date.now() - 60_000).toISOString() })
    await rememberChallenge(challengeStore, expired)
    const verify = makeVerifyChallengeBinding({ mode: 'stored-lookup', challengeStore })

    // Expires.assert throws first — store presence does not save it.
    await expect(verify(...pair(expired))).rejects.toThrow()
  })

  test('rejects when opaque present at verify but not at remember', async () => {
    const challengeStore = freshChallengeStore()
    const challenge = buildValidChallenge()
    await rememberChallenge(challengeStore, challenge)
    const verify = makeVerifyChallengeBinding({ mode: 'stored-lookup', challengeStore })

    const tampered = { ...challenge, opaque: 'injected' } as Challenge.Challenge
    await expect(verify(...pair(tampered))).rejects.toThrow(/'opaque' presence does not match/)
  })

  test('throws InvalidChallengeError class for any tamper', async () => {
    const challengeStore = freshChallengeStore()
    const challenge = buildValidChallenge()
    await rememberChallenge(challengeStore, challenge)
    const verify = makeVerifyChallengeBinding({ mode: 'stored-lookup', challengeStore })

    const tampered = { ...challenge, realm: 'https://attacker.example.com/' } as Challenge.Challenge
    await expect(verify(...pair(tampered))).rejects.toBeInstanceOf(Errors.InvalidChallengeError)
  })

  test('rejects when route request differs from stored challenge.request', async () => {
    const challengeStore = freshChallengeStore()
    const challenge = buildValidChallenge()
    await rememberChallenge(challengeStore, challenge)
    const verify = makeVerifyChallengeBinding({ mode: 'stored-lookup', challengeStore })

    const cred = wrapCred(challenge)
    const routeRequest = {
      ...(cred.challenge.request as Record<string, unknown>),
      currency: '0xdac17f958d2ee523a2206206994597c13d831ec7', // wrong token
    }
    await expect(verify(cred, routeRequest)).rejects.toThrow(/route request does not match/)
  })

  test('does NOT require server secret (stateless wrt HMAC by design)', async () => {
    // Challenge with deployment-supplied id (no HMAC) still verifies under
    // stored-lookup as long as the stored snapshot matches byte-for-byte.
    // mppx-hmac mode would reject the same challenge for HMAC mismatch.
    const challengeStore = freshChallengeStore()
    const challenge = Challenge.from({
      method: 'evm',
      intent: 'charge',
      realm: 'https://api.example.com/',
      request: MINIMAL_REQUEST,
      expires: new Date(Date.now() + 60_000).toISOString(),
      id: 'deployment-generated-id-not-hmac',
    })
    await rememberChallenge(challengeStore, challenge)
    const verify = makeVerifyChallengeBinding({ mode: 'stored-lookup', challengeStore })

    await expect(verify(...pair(challenge))).resolves.toBeUndefined()
  })
})
