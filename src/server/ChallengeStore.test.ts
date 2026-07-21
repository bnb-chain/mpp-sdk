/**
 * ChallengeStore primitives (spec §8.0.1 stored-lookup).
 *
 * Covers:
 *   - canonicalizeChallenge stable byte-form
 *   - remember/lookup/forget round-trip
 *   - constantTimeStringEqual equal/unequal/different-length all return
 *     the correct boolean (timing-uniformity is not test-asserted; it's
 *     a property of node:crypto.timingSafeEqual we rely on)
 */

import { Challenge, Store } from 'mppx'
import { describe, expect, test } from 'vitest'

import {
  type ChallengeStore,
  canonicalizeChallenge,
  constantTimeStringEqual,
  forgetChallenge,
  lookupChallenge,
  rememberChallenge,
} from './ChallengeStore.js'

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

function buildChallenge(overrides: { id?: string } = {}): Challenge.Challenge {
  if (overrides.id !== undefined) {
    return Challenge.from({
      method: 'evm',
      intent: 'charge',
      realm: 'https://api.example.com/',
      request: MINIMAL_REQUEST,
      expires: new Date(Date.now() + 60_000).toISOString(),
      id: overrides.id,
    })
  }
  return Challenge.from({
    method: 'evm',
    intent: 'charge',
    realm: 'https://api.example.com/',
    request: MINIMAL_REQUEST,
    expires: new Date(Date.now() + 60_000).toISOString(),
    secretKey: SECRET,
  })
}

function freshStore(): ChallengeStore {
  return Store.memory() as unknown as ChallengeStore
}

/* -------------------------------------------------------------------------- */
/*  canonicalizeChallenge                                                     */
/* -------------------------------------------------------------------------- */

describe('canonicalizeChallenge', () => {
  test('snapshot includes id / realm / method / intent / request / expires', () => {
    const challenge = buildChallenge()
    const snapshot = canonicalizeChallenge(challenge)
    expect(snapshot.id).toBe(challenge.id)
    expect(snapshot.realm).toBe(challenge.realm)
    expect(snapshot.method).toBe(challenge.method)
    expect(snapshot.intent).toBe(challenge.intent)
    expect(snapshot.expires).toBe(challenge.expires)
    // request is base64url JSON (PaymentRequest.serialize output)
    expect(snapshot.request).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  test('omits digest / opaque when absent', () => {
    const snapshot = canonicalizeChallenge(buildChallenge())
    expect(snapshot).not.toHaveProperty('digest')
    expect(snapshot).not.toHaveProperty('opaque')
  })

  test('same challenge canonicalizes to same snapshot (deterministic)', () => {
    const challenge = buildChallenge()
    const a = canonicalizeChallenge(challenge)
    const b = canonicalizeChallenge(challenge)
    expect(a).toStrictEqual(b)
  })

  test('different request content → different snapshot.request', () => {
    const c1 = buildChallenge({ id: 'abc' })
    const c2 = {
      ...c1,
      request: { ...c1.request, amount: '2000000' },
    } as Challenge.Challenge
    const a = canonicalizeChallenge(c1)
    const b = canonicalizeChallenge(c2)
    expect(a.request).not.toBe(b.request)
  })
})

/* -------------------------------------------------------------------------- */
/*  remember / lookup / forget                                                */
/* -------------------------------------------------------------------------- */

describe('rememberChallenge / lookupChallenge / forgetChallenge', () => {
  test('round-trip preserves the canonical snapshot', async () => {
    const store = freshStore()
    const challenge = buildChallenge()
    await rememberChallenge(store, challenge)

    const retrieved = await lookupChallenge(store, challenge.id)
    expect(retrieved).toStrictEqual(canonicalizeChallenge(challenge))
  })

  test('lookup of unknown id returns null', async () => {
    const store = freshStore()
    const retrieved = await lookupChallenge(store, 'nonexistent-id')
    expect(retrieved).toBeNull()
  })

  test('forget removes the snapshot', async () => {
    const store = freshStore()
    const challenge = buildChallenge()
    await rememberChallenge(store, challenge)

    expect(await lookupChallenge(store, challenge.id)).not.toBeNull()

    await forgetChallenge(store, challenge.id)
    expect(await lookupChallenge(store, challenge.id)).toBeNull()
  })

  test('forget of unknown id is a noop', async () => {
    const store = freshStore()
    await expect(forgetChallenge(store, 'never-seen-id')).resolves.toBeUndefined()
  })

  test('remember is idempotent under same id (overwrite)', async () => {
    const store = freshStore()
    const challenge = buildChallenge({ id: 'fixed-id' })
    await rememberChallenge(store, challenge)
    await rememberChallenge(store, challenge)
    expect(await lookupChallenge(store, 'fixed-id')).toStrictEqual(canonicalizeChallenge(challenge))
  })
})

/* -------------------------------------------------------------------------- */
/*  constantTimeStringEqual                                                   */
/* -------------------------------------------------------------------------- */

describe('constantTimeStringEqual', () => {
  test('returns true for equal strings', () => {
    expect(constantTimeStringEqual('abc', 'abc')).toBe(true)
    expect(constantTimeStringEqual('', '')).toBe(true)
  })

  test('returns false for unequal same-length strings', () => {
    expect(constantTimeStringEqual('abc', 'abd')).toBe(false)
  })

  test('returns false for different-length strings', () => {
    expect(constantTimeStringEqual('abc', 'abcd')).toBe(false)
    expect(constantTimeStringEqual('long', '')).toBe(false)
    expect(constantTimeStringEqual('', 'short')).toBe(false)
  })

  test('handles utf-8 multibyte strings', () => {
    // Multi-byte coverage without CJK (codebase policy keeps source
    // ASCII-only). 'café' / 'naïve' = 2-byte UTF-8 (Latin-1 Supplement);
    // 'résumé' / 'piñata' = same range, distinct bytes; emoji here
    // would also work (4-byte UTF-8) but Latin Extended already
    // exercises the same code path.
    expect(constantTimeStringEqual('café', 'café')).toBe(true)
    expect(constantTimeStringEqual('café', 'naïve')).toBe(false)
    expect(constantTimeStringEqual('résumé', 'résumé')).toBe(true)
    expect(constantTimeStringEqual('résumé', 'piñata')).toBe(false)
  })
})
