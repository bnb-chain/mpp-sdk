/**
 * Coverage for parseEvmChargeChallenge + assertCredentialTypeAccepted +
 * assertNoSplitsForNonPermit2 + assertMatchesChallengeRequest +
 * resolvePermit2Splits.
 *
 * The combined helper layer guarantees Permit2 / Authorization / Transaction
 * / Hash client constructors cannot serialize a credential that:
 *   - drifts wire fields from challenge.request
 *   - claims a type not in challenge.credentialTypes
 *   - tries to fulfill splits without permit2
 *   - silently uses caller-supplied splits that disagree with challenge
 */

import { Challenge } from 'mppx'
import { describe, expect, test } from 'vitest'

import {
  assertCredentialTypeAccepted,
  assertMatchesChallengeRequest,
  assertNoSplitsForNonPermit2,
  parseEvmChargeChallenge,
  resolvePermit2Splits,
} from './AssertChallenge.js'

const SECRET = 'r6-assert-challenge-secret'
const CHAIN_ID = 1
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3' as const
const RECIPIENT = '0x2222222222222222222222222222222222222222' as const
const SPLIT_RECIPIENT = '0x3333333333333333333333333333333333333333' as const
const AMOUNT = '1000000'

function makeChallenge(
  overrides: { credentialTypes?: readonly string[]; splits?: readonly unknown[] } = {},
) {
  const methodDetails: Record<string, unknown> = { chainId: CHAIN_ID, permit2Address: PERMIT2 }
  if (overrides.credentialTypes !== undefined) {
    methodDetails.credentialTypes = overrides.credentialTypes
  }
  if (overrides.splits !== undefined) methodDetails.splits = overrides.splits

  return Challenge.from({
    method: 'evm',
    intent: 'charge',
    realm: 'https://merchant.example/',
    request: { amount: AMOUNT, currency: USDC, recipient: RECIPIENT, methodDetails } as never,
    expires: new Date(Date.now() + 60_000).toISOString(),
    secretKey: SECRET,
  })
}

/* -------------------------------------------------------------------------- */
/*  parseEvmChargeChallenge                                                    */
/* -------------------------------------------------------------------------- */

describe('parseEvmChargeChallenge', () => {
  test('returns parsed wire request for a valid EVM Charge challenge', () => {
    const parsed = parseEvmChargeChallenge(makeChallenge())
    expect(parsed.amount).toBe(AMOUNT)
    expect(parsed.currency.toLowerCase()).toBe(USDC)
    expect(parsed.methodDetails.chainId).toBe(CHAIN_ID)
    expect(parsed.methodDetails.permit2Address.toLowerCase()).toBe(PERMIT2)
  })

  test('rejects non-EVM challenge.method (e.g. tempo)', () => {
    const bad = Challenge.from({
      method: 'tempo' as never,
      intent: 'charge',
      realm: 'https://merchant.example/',
      request: { amount: '1' } as never,
      expires: new Date(Date.now() + 60_000).toISOString(),
      secretKey: SECRET,
    })
    expect(() => parseEvmChargeChallenge(bad)).toThrow(
      /expected challenge\.method='evm', got 'tempo'/,
    )
  })

  test('rejects wrong intent (e.g. evm but intent=refund)', () => {
    const bad = Challenge.from({
      method: 'evm',
      intent: 'refund' as never,
      realm: 'https://merchant.example/',
      request: { amount: '1' } as never,
      expires: new Date(Date.now() + 60_000).toISOString(),
      secretKey: SECRET,
    })
    expect(() => parseEvmChargeChallenge(bad)).toThrow(/expected challenge\.intent='charge'/)
  })

  test('rejects malformed request (missing methodDetails)', () => {
    const bad = Challenge.from({
      method: 'evm',
      intent: 'charge',
      realm: 'https://merchant.example/',
      request: { amount: AMOUNT, currency: USDC, recipient: RECIPIENT } as never,
      expires: new Date(Date.now() + 60_000).toISOString(),
      secretKey: SECRET,
    })
    expect(() => parseEvmChargeChallenge(bad)).toThrow(/chargeMethod\.schema\.request\.parse/)
  })
})

/* -------------------------------------------------------------------------- */
/*  assertCredentialTypeAccepted (accepted set)                                */
/* -------------------------------------------------------------------------- */

describe('assertCredentialTypeAccepted', () => {
  test('passes when type is in challenge.credentialTypes', () => {
    const parsed = parseEvmChargeChallenge(makeChallenge({ credentialTypes: ['permit2', 'hash'] }))
    expect(() => assertCredentialTypeAccepted(parsed, 'permit2')).not.toThrow()
    expect(() => assertCredentialTypeAccepted(parsed, 'hash')).not.toThrow()
  })

  test('rejects when type is not in challenge.credentialTypes', () => {
    const parsed = parseEvmChargeChallenge(makeChallenge({ credentialTypes: ['hash'] }))
    expect(() => assertCredentialTypeAccepted(parsed, 'transaction')).toThrow(
      /'transaction' is not in the challenge's accepted credential set \[hash\]/,
    )
  })

  test("defaults to ['transaction','hash'] when credentialTypes is omitted (spec §6.3)", () => {
    const parsed = parseEvmChargeChallenge(makeChallenge())
    expect(() => assertCredentialTypeAccepted(parsed, 'transaction')).not.toThrow()
    expect(() => assertCredentialTypeAccepted(parsed, 'hash')).not.toThrow()
    expect(() => assertCredentialTypeAccepted(parsed, 'permit2')).toThrow(
      /'permit2' is not in.*\[transaction, hash\].*permit2 \/ authorization require explicit/,
    )
    expect(() => assertCredentialTypeAccepted(parsed, 'authorization')).toThrow(
      /'authorization' is not in.*\[transaction, hash\]/,
    )
  })
})

/* -------------------------------------------------------------------------- */
/*  assertNoSplitsForNonPermit2                                                */
/* -------------------------------------------------------------------------- */

describe('assertNoSplitsForNonPermit2', () => {
  test('passes when challenge has no splits', () => {
    const parsed = parseEvmChargeChallenge(makeChallenge())
    expect(() => assertNoSplitsForNonPermit2(parsed, 'hash')).not.toThrow()
    expect(() => assertNoSplitsForNonPermit2(parsed, 'transaction')).not.toThrow()
    expect(() => assertNoSplitsForNonPermit2(parsed, 'authorization')).not.toThrow()
  })

  test('rejects when challenge has splits + caller is non-permit2', () => {
    const parsed = parseEvmChargeChallenge(
      makeChallenge({
        credentialTypes: ['permit2'],
        splits: [{ recipient: SPLIT_RECIPIENT, amount: '100000' }],
      }),
    )
    expect(() => assertNoSplitsForNonPermit2(parsed, 'hash')).toThrow(
      /'hash' credentials cannot fulfill splits/,
    )
    expect(() => assertNoSplitsForNonPermit2(parsed, 'transaction')).toThrow(
      /'transaction' credentials cannot fulfill splits/,
    )
    expect(() => assertNoSplitsForNonPermit2(parsed, 'authorization')).toThrow(
      /'authorization' credentials cannot fulfill splits/,
    )
  })
})

/* -------------------------------------------------------------------------- */
/*  assertMatchesChallengeRequest (wire-field drift)                           */
/* -------------------------------------------------------------------------- */

const goodExpected = {
  chainId: CHAIN_ID,
  currency: USDC,
  recipient: RECIPIENT,
  amount: AMOUNT,
  permit2Address: PERMIT2,
} as const

describe('assertMatchesChallengeRequest happy path', () => {
  test('passes silently when every field matches', () => {
    const parsed = parseEvmChargeChallenge(makeChallenge())
    expect(() => assertMatchesChallengeRequest(parsed, goodExpected)).not.toThrow()
  })

  test('amount accepts bigint as well as decimal string', () => {
    const parsed = parseEvmChargeChallenge(makeChallenge())
    expect(() =>
      assertMatchesChallengeRequest(parsed, { ...goodExpected, amount: 1_000_000n }),
    ).not.toThrow()
  })

  test('currency / recipient / permit2Address compare case-insensitively (EIP-55 lenient)', () => {
    const parsed = parseEvmChargeChallenge(makeChallenge())
    const upper = (a: string) => a.toUpperCase().replace('0X', '0x') as `0x${string}`
    expect(() =>
      assertMatchesChallengeRequest(parsed, {
        ...goodExpected,
        currency: upper(USDC),
        recipient: upper(RECIPIENT),
        permit2Address: upper(PERMIT2),
      }),
    ).not.toThrow()
  })

  test('permit2Address omitted (Hash / Authorization / Transaction callsites)', () => {
    const parsed = parseEvmChargeChallenge(makeChallenge())
    const { permit2Address: _ignored, ...withoutPermit2 } = goodExpected
    expect(() => assertMatchesChallengeRequest(parsed, withoutPermit2)).not.toThrow()
  })
})

describe('assertMatchesChallengeRequest drift detection', () => {
  test('throws on chainId drift (caller=137 vs challenge=1)', () => {
    const parsed = parseEvmChargeChallenge(makeChallenge())
    expect(() => assertMatchesChallengeRequest(parsed, { ...goodExpected, chainId: 137 })).toThrow(
      /'chainId' mismatch — caller 137 vs challenge.*1/,
    )
  })

  test('throws on currency drift (caller=different ERC-20)', () => {
    const parsed = parseEvmChargeChallenge(makeChallenge())
    const usdt = '0xdac17f958d2ee523a2206206994597c13d831ec7' as const
    expect(() =>
      assertMatchesChallengeRequest(parsed, { ...goodExpected, currency: usdt }),
    ).toThrow(/'currency' mismatch/)
  })

  test('throws on recipient drift', () => {
    const parsed = parseEvmChargeChallenge(makeChallenge())
    const other = '0x4444444444444444444444444444444444444444' as const
    expect(() =>
      assertMatchesChallengeRequest(parsed, { ...goodExpected, recipient: other }),
    ).toThrow(/'recipient' mismatch/)
  })

  test('throws on amount drift (caller=2_000_000 vs challenge=1_000_000)', () => {
    const parsed = parseEvmChargeChallenge(makeChallenge())
    expect(() =>
      assertMatchesChallengeRequest(parsed, { ...goodExpected, amount: '2000000' }),
    ).toThrow(/'amount' mismatch — caller 2000000 vs challenge.*1000000/)
  })

  test('throws on permit2Address drift', () => {
    const parsed = parseEvmChargeChallenge(makeChallenge())
    const fork = '0x1111111111111111111111111111111111111111' as const
    expect(() =>
      assertMatchesChallengeRequest(parsed, { ...goodExpected, permit2Address: fork }),
    ).toThrow(/'permit2Address' mismatch/)
  })

  test('throws on non-parseable caller amount (defensive)', () => {
    const parsed = parseEvmChargeChallenge(makeChallenge())
    expect(() =>
      assertMatchesChallengeRequest(parsed, { ...goodExpected, amount: 'not-a-number' }),
    ).toThrow(/is not parseable as bigint/)
  })
})

/* -------------------------------------------------------------------------- */
/*  resolvePermit2Splits                                                       */
/* -------------------------------------------------------------------------- */

describe('resolvePermit2Splits', () => {
  test('returns empty array when challenge has no splits + caller omitted', () => {
    const parsed = parseEvmChargeChallenge(makeChallenge())
    expect(resolvePermit2Splits(parsed, undefined)).toEqual([])
  })

  test('returns canonical wire splits when caller omitted', () => {
    const wire = [{ recipient: SPLIT_RECIPIENT, amount: '100000' }]
    const parsed = parseEvmChargeChallenge(
      makeChallenge({ credentialTypes: ['permit2'], splits: wire }),
    )
    const out = resolvePermit2Splits(parsed, undefined)
    expect(out).toHaveLength(1)
    expect(out[0]!.recipient.toLowerCase()).toBe(SPLIT_RECIPIENT)
    expect(out[0]!.amount).toBe('100000')
  })

  test('accepts caller splits that deep-equal challenge', () => {
    const wire = [{ recipient: SPLIT_RECIPIENT, amount: '100000' }]
    const parsed = parseEvmChargeChallenge(
      makeChallenge({ credentialTypes: ['permit2'], splits: wire }),
    )
    expect(() =>
      resolvePermit2Splits(parsed, [{ recipient: SPLIT_RECIPIENT, amount: '100000' }]),
    ).not.toThrow()
  })

  test('rejects caller splits with mismatched length', () => {
    const wire = [{ recipient: SPLIT_RECIPIENT, amount: '100000' }]
    const parsed = parseEvmChargeChallenge(
      makeChallenge({ credentialTypes: ['permit2'], splits: wire }),
    )
    expect(() =>
      resolvePermit2Splits(parsed, [
        { recipient: SPLIT_RECIPIENT, amount: '100000' },
        { recipient: SPLIT_RECIPIENT, amount: '50000' },
      ]),
    ).toThrow(/opts\.splits\.length \(2\).*does not match challenge.*\(1\)/)
  })

  test('rejects per-entry recipient mismatch', () => {
    const wire = [{ recipient: SPLIT_RECIPIENT, amount: '100000' }]
    const parsed = parseEvmChargeChallenge(
      makeChallenge({ credentialTypes: ['permit2'], splits: wire }),
    )
    const drifted = '0x4444444444444444444444444444444444444444' as const
    expect(() => resolvePermit2Splits(parsed, [{ recipient: drifted, amount: '100000' }])).toThrow(
      /opts\.splits\[0\]\.recipient.*does not match/,
    )
  })

  test('rejects per-entry amount mismatch', () => {
    const wire = [{ recipient: SPLIT_RECIPIENT, amount: '100000' }]
    const parsed = parseEvmChargeChallenge(
      makeChallenge({ credentialTypes: ['permit2'], splits: wire }),
    )
    expect(() =>
      resolvePermit2Splits(parsed, [{ recipient: SPLIT_RECIPIENT, amount: '200000' }]),
    ).toThrow(/opts\.splits\[0\]\.amount \(200000\).*does not match.*\(100000\)/)
  })
})
