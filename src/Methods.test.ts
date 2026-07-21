/**
 * Wire allowlist output schema tests for chargeMethod.
 *
 * Coverage targets (spec §6 / §14.6.1):
 *   1. REQUIRED fields throw on parse if missing
 *   2. Field-level format guards (amount integer-only, chainId positive int,
 *      decimals 0..36, address hex shape)
 *   3. Cross-field check: sum(splits[].amount) < amount
 *   4. Unknown / denylist fields are stripped from output (not rejected)
 *   5. credentialPayload wire schema (per-type discriminated union guards:
 *      signature 64/65-byte lengths, decimal-string nonce/deadline, bytes32
 *      nonce/hash, minLength(1) arrays)
 *
 * Test addresses are explicit lowercase 20-byte hex. Using `'0x...'` triggers
 * the address-regex schema first and masks downstream REQUIRED-field guards.
 */

import { describe, expect, test } from 'vitest'

import { chargeMethod } from './Methods.js'

/* -------------------------------------------------------------------------- */
/*  Fixture constants                                                         */
/* -------------------------------------------------------------------------- */

const RECIPIENT = '0x2222222222222222222222222222222222222222'
const CURRENCY = '0x1111111111111111111111111111111111111111'
const SPLIT_RECIPIENT = '0x3333333333333333333333333333333333333333'
const CANONICAL_PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'

const MINIMAL_VALID_REQUEST = {
  amount: '1000000',
  currency: CURRENCY,
  recipient: RECIPIENT,
  methodDetails: {
    chainId: 56,
    permit2Address: CANONICAL_PERMIT2,
  },
} as const

/* -------------------------------------------------------------------------- */
/*  1. REQUIRED field guards                                                  */
/* -------------------------------------------------------------------------- */

describe('chargeMethod.schema.request REQUIRED field guards', () => {
  test('happy path: minimal valid request parses', () => {
    expect(() => chargeMethod.schema.request.parse(MINIMAL_VALID_REQUEST)).not.toThrow()
  })

  test('rejects request missing methodDetails.permit2Address', () => {
    expect(() =>
      chargeMethod.schema.request.parse({
        amount: '1000000',
        currency: CURRENCY,
        recipient: RECIPIENT,
        methodDetails: { chainId: 56 /* permit2Address missing */ },
      } as unknown),
    ).toThrow(/permit2Address/i)
  })

  test('rejects request missing methodDetails.chainId', () => {
    expect(() =>
      chargeMethod.schema.request.parse({
        amount: '1000000',
        currency: CURRENCY,
        recipient: RECIPIENT,
        methodDetails: { permit2Address: CANONICAL_PERMIT2 },
      } as unknown),
    ).toThrow(/chainId/i)
  })

  test('rejects request missing methodDetails entirely', () => {
    expect(() =>
      chargeMethod.schema.request.parse({
        amount: '1000000',
        currency: CURRENCY,
        recipient: RECIPIENT,
      } as unknown),
    ).toThrow(/methodDetails/i)
  })

  test('rejects request missing amount', () => {
    expect(() =>
      chargeMethod.schema.request.parse({
        currency: CURRENCY,
        recipient: RECIPIENT,
        methodDetails: { chainId: 56, permit2Address: CANONICAL_PERMIT2 },
      } as unknown),
    ).toThrow(/amount/i)
  })

  test('rejects request missing currency', () => {
    expect(() =>
      chargeMethod.schema.request.parse({
        amount: '1000000',
        recipient: RECIPIENT,
        methodDetails: { chainId: 56, permit2Address: CANONICAL_PERMIT2 },
      } as unknown),
    ).toThrow(/currency/i)
  })

  test('rejects request missing recipient', () => {
    expect(() =>
      chargeMethod.schema.request.parse({
        amount: '1000000',
        currency: CURRENCY,
        methodDetails: { chainId: 56, permit2Address: CANONICAL_PERMIT2 },
      } as unknown),
    ).toThrow(/recipient/i)
  })
})

/* -------------------------------------------------------------------------- */
/*  2. Field format guards                                                    */
/* -------------------------------------------------------------------------- */

describe('chargeMethod.schema.request field format guards', () => {
  test('rejects decimal amount (draft §4.1 base-units integer only)', () => {
    expect(() =>
      chargeMethod.schema.request.parse({ ...MINIMAL_VALID_REQUEST, amount: '1.5' }),
    ).toThrow(/amount/i)
  })

  test('rejects zero amount (positive integer only)', () => {
    expect(() =>
      chargeMethod.schema.request.parse({ ...MINIMAL_VALID_REQUEST, amount: '0' }),
    ).toThrow(/amount/i)
  })

  test('rejects negative amount', () => {
    expect(() =>
      chargeMethod.schema.request.parse({ ...MINIMAL_VALID_REQUEST, amount: '-1' }),
    ).toThrow(/amount/i)
  })

  test('rejects chainId 0 (must be positive)', () => {
    expect(() =>
      chargeMethod.schema.request.parse({
        ...MINIMAL_VALID_REQUEST,
        methodDetails: { ...MINIMAL_VALID_REQUEST.methodDetails, chainId: 0 },
      }),
    ).toThrow(/chainId/i)
  })

  test('rejects chainId negative', () => {
    expect(() =>
      chargeMethod.schema.request.parse({
        ...MINIMAL_VALID_REQUEST,
        methodDetails: { ...MINIMAL_VALID_REQUEST.methodDetails, chainId: -1 },
      }),
    ).toThrow(/chainId/i)
  })

  test('rejects chainId non-integer', () => {
    expect(() =>
      chargeMethod.schema.request.parse({
        ...MINIMAL_VALID_REQUEST,
        methodDetails: { ...MINIMAL_VALID_REQUEST.methodDetails, chainId: 1.5 },
      }),
    ).toThrow(/chainId/i)
  })

  test('rejects decimals > 36 (wei/gwei confusion guard)', () => {
    expect(() =>
      chargeMethod.schema.request.parse({
        ...MINIMAL_VALID_REQUEST,
        methodDetails: { ...MINIMAL_VALID_REQUEST.methodDetails, decimals: 50 },
      }),
    ).toThrow(/decimals/i)
  })

  test('rejects decimals non-integer', () => {
    expect(() =>
      chargeMethod.schema.request.parse({
        ...MINIMAL_VALID_REQUEST,
        methodDetails: { ...MINIMAL_VALID_REQUEST.methodDetails, decimals: 6.5 },
      }),
    ).toThrow(/decimals/i)
  })

  test('rejects malformed permit2Address (not 20 bytes)', () => {
    expect(() =>
      chargeMethod.schema.request.parse({
        ...MINIMAL_VALID_REQUEST,
        methodDetails: { ...MINIMAL_VALID_REQUEST.methodDetails, permit2Address: '0xabc' },
      }),
    ).toThrow(/permit2Address/i)
  })

  test('rejects malformed currency (not 0x-prefixed)', () => {
    expect(() =>
      chargeMethod.schema.request.parse({
        ...MINIMAL_VALID_REQUEST,
        currency: '1111111111111111111111111111111111111111',
      }),
    ).toThrow(/currency/i)
  })

  test('accepts mixed-case address (no EIP-55 enforcement)', () => {
    // EIP-55 is SHOULD, not MUST. Schema must accept mixed-case input;
    // downstream code lowercases before compare.
    expect(() =>
      chargeMethod.schema.request.parse({
        ...MINIMAL_VALID_REQUEST,
        currency: '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01',
      }),
    ).not.toThrow()
  })
})

/* -------------------------------------------------------------------------- */
/*  3. Cross-field: sum(splits[].amount) < amount                             */
/* -------------------------------------------------------------------------- */

describe('chargeMethod.schema.request sum(splits) < amount (draft §4.2.3)', () => {
  test('accepts splits when sum < amount', () => {
    expect(() =>
      chargeMethod.schema.request.parse({
        ...MINIMAL_VALID_REQUEST,
        amount: '1000000',
        methodDetails: {
          ...MINIMAL_VALID_REQUEST.methodDetails,
          splits: [{ recipient: SPLIT_RECIPIENT, amount: '300000' }],
        },
      }),
    ).not.toThrow()
  })

  test('rejects splits when sum == amount (strict <)', () => {
    expect(() =>
      chargeMethod.schema.request.parse({
        ...MINIMAL_VALID_REQUEST,
        amount: '1000000',
        methodDetails: {
          ...MINIMAL_VALID_REQUEST.methodDetails,
          splits: [{ recipient: SPLIT_RECIPIENT, amount: '1000000' }],
        },
      }),
    ).toThrow(/sum.*splits/i)
  })

  test('rejects splits when sum > amount', () => {
    expect(() =>
      chargeMethod.schema.request.parse({
        ...MINIMAL_VALID_REQUEST,
        amount: '1000000',
        methodDetails: {
          ...MINIMAL_VALID_REQUEST.methodDetails,
          splits: [
            { recipient: SPLIT_RECIPIENT, amount: '600000' },
            { recipient: SPLIT_RECIPIENT, amount: '500000' },
          ],
        },
      }),
    ).toThrow(/sum.*splits/i)
  })
})

/* -------------------------------------------------------------------------- */
/*  4. Denylist: SDK-internal fields stripped from output                     */
/* -------------------------------------------------------------------------- */

const WIRE_DENYLIST = [
  'feePayer',
  'feeSponsor',
  'settlementAccount',
  'settlementWalletClient',
  'serverAccount',
  'gasAccount',
  'rpcUrl',
  'apiKey',
  'privateKey',
  'serverNonce',
] as const

describe('chargeMethod.schema.request denylist (SDK internals stripped on parse)', () => {
  test.each(WIRE_DENYLIST)('strips top-level %s', (banned) => {
    const parsed = chargeMethod.schema.request.parse({
      ...MINIMAL_VALID_REQUEST,
      [banned]: 'leaked-value',
    } as unknown as typeof MINIMAL_VALID_REQUEST) as Record<string, unknown>
    expect(parsed).not.toHaveProperty(banned)
  })

  test.each(WIRE_DENYLIST)('strips %s nested in methodDetails', (banned) => {
    const parsed = chargeMethod.schema.request.parse({
      ...MINIMAL_VALID_REQUEST,
      methodDetails: {
        ...MINIMAL_VALID_REQUEST.methodDetails,
        [banned]: 'leaked-value',
      } as unknown,
    }) as { methodDetails: Record<string, unknown> }
    expect(parsed.methodDetails).not.toHaveProperty(banned)
  })
})

/* -------------------------------------------------------------------------- */
/*  5. credentialPayload wire schema                                          */
/* -------------------------------------------------------------------------- */

const credentialPayload = chargeMethod.schema.credential.payload

// evmSignature accepts exactly 64-byte (EIP-2098 compact, 0x + 128 hex) or
// 65-byte (r||s||v, 0x + 130 hex). Anything else — like 0x + 100 hex — rejects.
const SIG_64_BYTE = `0x${'cd'.repeat(64)}`
const SIG_65_BYTE = `0x${'ab'.repeat(65)}`
const SIG_WRONG_LENGTH = `0x${'a'.repeat(100)}`
const BYTES32 = `0x${'11'.repeat(32)}`

const VALID_PERMIT2_PAYLOAD = {
  type: 'permit2',
  permit: {
    permitted: [{ token: CURRENCY, amount: '1000000' }],
    nonce: '1',
    deadline: '1700000000',
  },
  transferDetails: [{ to: RECIPIENT, requestedAmount: '1000000' }],
  witness: { challengeHash: BYTES32, externalId: '' },
  signature: SIG_65_BYTE,
} as const

const VALID_AUTHORIZATION_PAYLOAD = {
  type: 'authorization',
  from: CURRENCY,
  to: RECIPIENT,
  value: '1000000',
  validAfter: '0',
  validBefore: '1700000000',
  nonce: BYTES32,
  signature: SIG_65_BYTE,
} as const

describe('credentialPayload wire schema', () => {
  describe('permit2', () => {
    test('happy path: valid permit2 payload parses (65-byte r||s||v signature)', () => {
      expect(() => credentialPayload.parse(VALID_PERMIT2_PAYLOAD)).not.toThrow()
    })

    test('accepts 64-byte EIP-2098 compact signature', () => {
      expect(() =>
        credentialPayload.parse({ ...VALID_PERMIT2_PAYLOAD, signature: SIG_64_BYTE }),
      ).not.toThrow()
    })

    test('rejects signature with wrong hex length (0x + 100 chars)', () => {
      expect(() =>
        credentialPayload.parse({ ...VALID_PERMIT2_PAYLOAD, signature: SIG_WRONG_LENGTH }),
      ).toThrow(/signature/i)
    })

    test('rejects empty permit.permitted [] (minLength 1)', () => {
      expect(() =>
        credentialPayload.parse({
          ...VALID_PERMIT2_PAYLOAD,
          permit: { ...VALID_PERMIT2_PAYLOAD.permit, permitted: [] },
        }),
      ).toThrow(/permitted/i)
    })

    test('rejects empty transferDetails [] (minLength 1)', () => {
      expect(() =>
        credentialPayload.parse({ ...VALID_PERMIT2_PAYLOAD, transferDetails: [] }),
      ).toThrow(/transferDetails/i)
    })

    test('rejects non-decimal nonce "0x12" (uint256 decimal string only)', () => {
      expect(() =>
        credentialPayload.parse({
          ...VALID_PERMIT2_PAYLOAD,
          permit: { ...VALID_PERMIT2_PAYLOAD.permit, nonce: '0x12' },
        }),
      ).toThrow(/nonce/i)
    })

    test('rejects non-decimal nonce "abc"', () => {
      expect(() =>
        credentialPayload.parse({
          ...VALID_PERMIT2_PAYLOAD,
          permit: { ...VALID_PERMIT2_PAYLOAD.permit, nonce: 'abc' },
        }),
      ).toThrow(/nonce/i)
    })

    test('rejects non-decimal deadline (unix seconds decimal string only)', () => {
      expect(() =>
        credentialPayload.parse({
          ...VALID_PERMIT2_PAYLOAD,
          permit: { ...VALID_PERMIT2_PAYLOAD.permit, deadline: '0x12' },
        }),
      ).toThrow(/deadline/i)
    })
  })

  describe('authorization', () => {
    test('happy path: valid bytes32 nonce parses', () => {
      expect(() => credentialPayload.parse(VALID_AUTHORIZATION_PAYLOAD)).not.toThrow()
    })

    test('rejects nonce that is too short (not 32 bytes)', () => {
      expect(() =>
        credentialPayload.parse({ ...VALID_AUTHORIZATION_PAYLOAD, nonce: '0x1234' }),
      ).toThrow(/nonce/i)
    })

    test('rejects nonce without 0x prefix', () => {
      expect(() =>
        credentialPayload.parse({ ...VALID_AUTHORIZATION_PAYLOAD, nonce: '11'.repeat(32) }),
      ).toThrow(/nonce/i)
    })

    test('accepts 64-byte EIP-2098 compact signature', () => {
      expect(() =>
        credentialPayload.parse({ ...VALID_AUTHORIZATION_PAYLOAD, signature: SIG_64_BYTE }),
      ).not.toThrow()
    })

    test('rejects signature with wrong hex length (0x + 100 chars)', () => {
      expect(() =>
        credentialPayload.parse({ ...VALID_AUTHORIZATION_PAYLOAD, signature: SIG_WRONG_LENGTH }),
      ).toThrow(/signature/i)
    })
  })

  describe('transaction', () => {
    test('happy path: 0x-prefixed hex raw transaction parses (length unconstrained)', () => {
      expect(() =>
        credentialPayload.parse({ type: 'transaction', signature: '0x02f87082' }),
      ).not.toThrow()
    })

    test('rejects malformed signature (not hex)', () => {
      expect(() => credentialPayload.parse({ type: 'transaction', signature: 'not-hex' })).toThrow(
        /signature/i,
      )
    })
  })

  describe('hash', () => {
    test('happy path: valid 32-byte tx hash parses', () => {
      expect(() => credentialPayload.parse({ type: 'hash', hash: BYTES32 })).not.toThrow()
    })

    test('rejects hash that is too short (not 32 bytes)', () => {
      expect(() => credentialPayload.parse({ type: 'hash', hash: '0x1234' })).toThrow(/hash/i)
    })

    test('rejects hash without 0x prefix', () => {
      expect(() => credentialPayload.parse({ type: 'hash', hash: 'de'.repeat(32) })).toThrow(
        /hash/i,
      )
    })
  })
})

/* -------------------------------------------------------------------------- */
/*  6. Method identity sanity                                                 */
/* -------------------------------------------------------------------------- */

test('chargeMethod identity matches draft (name=evm, intent=charge)', () => {
  expect(chargeMethod.name).toBe('evm')
  expect(chargeMethod.intent).toBe('charge')
})
