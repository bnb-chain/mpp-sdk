/**
 * EIP-712 type-data byte-for-byte invariants.
 *
 * Two layers of protection:
 *
 *   1. Type-string + struct identity — accidental edits to PaymentWitness,
 *      TokenPermissions, or TransferWithAuthorization break cross-implementation
 *      verifiability. Pin the strings and struct shapes verbatim.
 *
 *   2. Frozen-hex fixtures — compute the EIP-712 hash for a fully specified
 *      Permit2 single / Permit2 batch / EIP-3009 message and compare against
 *      a hash we captured once with viem.hashTypedData. Any drift in domain,
 *      struct layout, or hashing semantics will flip these hashes.
 *
 * Regenerating fixtures (only when the draft itself changes):
 *   1. Update PERMIT2_WITNESS_TYPE_STRING / type structs / domain factory.
 *   2. Re-run the inline script in this PR's commit message to capture new
 *      hashes, then update the constants below.
 *   3. Document the draft revision bump in REWRITE-SPEC v2.X+1 changelog.
 */

import { hashTypedData } from 'viem'
import { describe, expect, test } from 'vitest'

import {
  PERMIT2_WITNESS_TYPE_STRING,
  computeChallengeHash,
  eip3009Domain,
  eip3009Nonce,
  eip3009Types,
  permit2BatchTypes,
  permit2Domain,
  permit2SingleTypes,
} from './TypedData.js'

/* -------------------------------------------------------------------------- */
/*  1. Type-string + struct identity                                          */
/* -------------------------------------------------------------------------- */

describe('PERMIT2_WITNESS_TYPE_STRING (draft-evm-charge-00 §5.2)', () => {
  test('byte-for-byte spec string', () => {
    expect(PERMIT2_WITNESS_TYPE_STRING).toBe(
      'PaymentWitness witness)PaymentWitness(bytes32 challengeHash)TokenPermissions(address token,uint256 amount)',
    )
  })
})

describe('PaymentWitness invariant: only { challengeHash }', () => {
  test('permit2SingleTypes.PaymentWitness has exactly one field', () => {
    expect(permit2SingleTypes.PaymentWitness).toEqual([{ name: 'challengeHash', type: 'bytes32' }])
  })

  test('permit2BatchTypes.PaymentWitness has exactly one field (matches single)', () => {
    expect(permit2BatchTypes.PaymentWitness).toEqual(permit2SingleTypes.PaymentWitness)
  })
})

describe('Permit2 struct identity', () => {
  test('TokenPermissions is { token, amount } in both single and batch', () => {
    const expected = [
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ]
    expect(permit2SingleTypes.TokenPermissions).toEqual(expected)
    expect(permit2BatchTypes.TokenPermissions).toEqual(expected)
  })

  test('PermitWitnessTransferFrom shape (single)', () => {
    expect(permit2SingleTypes.PermitWitnessTransferFrom).toEqual([
      { name: 'permitted', type: 'TokenPermissions' },
      { name: 'spender', type: 'address' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'witness', type: 'PaymentWitness' },
    ])
  })

  test('PermitBatchWitnessTransferFrom uses array type for permitted', () => {
    const batchPermitted = permit2BatchTypes.PermitBatchWitnessTransferFrom.find(
      (f) => f.name === 'permitted',
    )
    expect(batchPermitted?.type).toBe('TokenPermissions[]')
  })
})

describe('EIP-3009 TransferWithAuthorization struct', () => {
  test('exact field order and types per EIP-3009', () => {
    expect(eip3009Types.TransferWithAuthorization).toEqual([
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ])
  })
})

/* -------------------------------------------------------------------------- */
/*  2. challengeHash / eip3009Nonce determinism                               */
/* -------------------------------------------------------------------------- */

describe('challengeHash / eip3009Nonce', () => {
  const CHALLENGE_ID = 'chal_0123456789abcdef'
  const REALM = 'https://api.example.com/'
  // Captured 2026-05-28 via:
  //   keccak256(encodePacked(['string','string'], [CHALLENGE_ID, REALM]))
  const EXPECTED = '0xc6f3582f541a625d439268a7457ced2fcc3c8fdc4a223a5952fa4c31483b9dbc'

  test('computeChallengeHash produces frozen value for fixed input', () => {
    expect(computeChallengeHash(CHALLENGE_ID, REALM)).toBe(EXPECTED)
  })

  test('eip3009Nonce shares the construction (same fixed value)', () => {
    expect(eip3009Nonce(CHALLENGE_ID, REALM)).toBe(EXPECTED)
  })

  test('hash flips when challengeId changes (binding sensitivity)', () => {
    const alt = computeChallengeHash('chal_different', REALM)
    expect(alt).not.toBe(EXPECTED)
  })

  test('hash flips when realm changes (binding sensitivity)', () => {
    const alt = computeChallengeHash(CHALLENGE_ID, 'https://other.example.com/')
    expect(alt).not.toBe(EXPECTED)
  })
})

/* -------------------------------------------------------------------------- */
/*  3. Frozen-hex EIP-712 hash fixtures                                       */
/* -------------------------------------------------------------------------- */

const CHALLENGE_ID = 'chal_0123456789abcdef'
const REALM = 'https://api.example.com/'
const CHAIN_ID = 56
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3' as const
const TOKEN = '0x55d398326f99059ff775485246999027b3197955' as const
const RECIPIENT = '0x2222222222222222222222222222222222222222' as const
const PAYER = '0x1111111111111111111111111111111111111111' as const
const USDC_ETH = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const

const challengeHash = computeChallengeHash(CHALLENGE_ID, REALM)

describe('Permit2 single hashTypedData fixture', () => {
  test('matches captured hash (drift detector)', () => {
    const hash = hashTypedData({
      domain: permit2Domain(CHAIN_ID, PERMIT2),
      types: permit2SingleTypes,
      primaryType: 'PermitWitnessTransferFrom',
      message: {
        permitted: { token: TOKEN, amount: 1_000_000n },
        spender: RECIPIENT,
        nonce: 42n,
        deadline: 1_800_000_000n,
        witness: { challengeHash },
      },
    })
    // Captured 2026-05-28 with viem.hashTypedData.
    expect(hash).toBe('0xbecc86e1ed953196b5bfa880a5d2429f85a488788e9796f417cc3cec7da37c11')
  })
})

describe('Permit2 batch hashTypedData fixture', () => {
  test('matches captured hash (drift detector)', () => {
    const hash = hashTypedData({
      domain: permit2Domain(CHAIN_ID, PERMIT2),
      types: permit2BatchTypes,
      primaryType: 'PermitBatchWitnessTransferFrom',
      message: {
        permitted: [
          { token: TOKEN, amount: 700_000n },
          { token: TOKEN, amount: 300_000n },
        ],
        spender: RECIPIENT,
        nonce: 43n,
        deadline: 1_800_000_000n,
        witness: { challengeHash },
      },
    })
    // Captured 2026-05-28 with viem.hashTypedData.
    expect(hash).toBe('0x207ea0c8ea5009756549374e047c20c067cdfd0840e7c03b309e531e3432fd62')
  })
})

describe('EIP-3009 hashTypedData fixture (Circle USDC on ethereum)', () => {
  test('matches captured hash (drift detector)', () => {
    const hash = hashTypedData({
      domain: eip3009Domain({
        tokenName: 'USD Coin',
        tokenVersion: '2',
        chainId: 1,
        tokenAddress: USDC_ETH,
      }),
      types: eip3009Types,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: PAYER,
        to: RECIPIENT,
        value: 1_000_000n,
        validAfter: 0n,
        validBefore: 1_800_000_000n,
        nonce: eip3009Nonce(CHALLENGE_ID, REALM),
      },
    })
    // Captured 2026-05-28 with viem.hashTypedData.
    expect(hash).toBe('0x848d01d6cd45facdb536a2908a1586aeea832fd655819f697da9a77c855772be')
  })
})

/* -------------------------------------------------------------------------- */
/*  4. Domain factories                                                       */
/* -------------------------------------------------------------------------- */

describe('domain factories', () => {
  test('permit2Domain uses passed verifyingContract (not a global constant)', () => {
    const overrideAddr = '0x000000000000000000000000000000000000aaaa' as const
    expect(permit2Domain(CHAIN_ID, overrideAddr)).toEqual({
      name: 'Permit2',
      chainId: CHAIN_ID,
      verifyingContract: overrideAddr,
    })
  })

  test('eip3009Domain pulls tokenName/version/address from params', () => {
    expect(
      eip3009Domain({
        tokenName: 'USD Coin',
        tokenVersion: '2',
        chainId: 1,
        tokenAddress: USDC_ETH,
      }),
    ).toEqual({
      name: 'USD Coin',
      version: '2',
      chainId: 1,
      verifyingContract: USDC_ETH,
    })
  })
})
