/**
 * viem independent cross-check (spec §14.4).
 *
 * Computes the same EIP-712 typed-data hash via two independent paths:
 *
 *   Path A:  SDK exports — `permit2SingleTypes` / `permit2BatchTypes` /
 *            `eip3009Types` + `permit2Domain` / `eip3009Domain` +
 *            viem.hashTypedData.
 *
 *   Path B:  Manually inlined struct definitions + domain literal, NO SDK
 *            imports — purely viem + raw types. This is the "external
 *            independent re-implementation" check spec §14.4 requires.
 *
 * Both paths fed to viem.hashTypedData must produce identical bytes.
 * Drift in the SDK's typed-data exports (field order, name, struct
 * shape) would surface as a hash mismatch here.
 *
 * Additionally: sign + recover round-trip per type — proves the SDK's
 * domain + types form a valid signing surface (not just hash-equal).
 */

import { type TypedDataDomain, hashTypedData, recoverTypedDataAddress, signatureToHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sign } from 'viem/accounts'
import { describe, expect, test } from 'vitest'

// TypedData helpers are SDK-internal (not in the @bnb-chain/mpp/server
// public barrel) — import via the relative source path the verifiers use.
import {
  computeChallengeHash,
  eip3009Domain,
  eip3009Nonce,
  eip3009Types,
  permit2BatchTypes,
  permit2Domain,
  permit2SingleTypes,
} from '../../src/protocol/TypedData.js'

const PK = '0x1111111111111111111111111111111111111111111111111111111111111111' as const
const ACCOUNT = privateKeyToAccount(PK)
const SIGNER = ACCOUNT.address

const CHAIN_ID = 1
const CURRENCY = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3' as const
const RECIPIENT = '0x2222222222222222222222222222222222222222' as const
const AMOUNT = 1_000_000n
const NONCE = 12345n
const DEADLINE = 1_900_000_000n
const REALM = 'https://test.example/'
const CHALLENGE_ID = 'chal_xcheck'
const CHALLENGE_HASH = computeChallengeHash(CHALLENGE_ID, REALM)
const EXTERNAL_ID = 'order-cross-check'

/* -------------------------------------------------------------------------- */
/*  Path B baselines — inline definitions (NO SDK imports)                    */
/* -------------------------------------------------------------------------- */

const INLINE_PERMIT2_DOMAIN: TypedDataDomain = {
  name: 'Permit2',
  chainId: CHAIN_ID,
  verifyingContract: PERMIT2,
}

const INLINE_PERMIT2_SINGLE_TYPES = {
  PermitWitnessTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'witness', type: 'PaymentWitness' },
  ],
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  PaymentWitness: [
    { name: 'challengeHash', type: 'bytes32' },
    { name: 'externalId', type: 'string' },
  ],
} as const

const INLINE_PERMIT2_BATCH_TYPES = {
  PermitBatchWitnessTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions[]' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'witness', type: 'PaymentWitness' },
  ],
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  PaymentWitness: [
    { name: 'challengeHash', type: 'bytes32' },
    { name: 'externalId', type: 'string' },
  ],
} as const

const INLINE_EIP3009_DOMAIN_USDC: TypedDataDomain = {
  name: 'USD Coin',
  version: '2',
  chainId: CHAIN_ID,
  verifyingContract: CURRENCY,
}

const INLINE_EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

/* -------------------------------------------------------------------------- */
/*  Permit2 single                                                            */
/* -------------------------------------------------------------------------- */

describe('Permit2 single typed-data — SDK exports vs inline match', () => {
  const message = {
    permitted: { token: CURRENCY, amount: AMOUNT },
    spender: PERMIT2,
    nonce: NONCE,
    deadline: DEADLINE,
    witness: { challengeHash: CHALLENGE_HASH, externalId: EXTERNAL_ID },
  }

  test('hashTypedData identical via Path A (SDK) vs Path B (inline)', () => {
    const hashA = hashTypedData({
      domain: permit2Domain(CHAIN_ID, PERMIT2),
      types: permit2SingleTypes,
      primaryType: 'PermitWitnessTransferFrom',
      message,
    })
    const hashB = hashTypedData({
      domain: INLINE_PERMIT2_DOMAIN,
      types: INLINE_PERMIT2_SINGLE_TYPES,
      primaryType: 'PermitWitnessTransferFrom',
      message,
    })
    expect(hashA).toBe(hashB)
  })

  test('sign + recover round-trip recovers SIGNER address', async () => {
    const sigObj = await sign({
      privateKey: PK,
      hash: hashTypedData({
        domain: permit2Domain(CHAIN_ID, PERMIT2),
        types: permit2SingleTypes,
        primaryType: 'PermitWitnessTransferFrom',
        message,
      }),
    })
    const signature = signatureToHex(sigObj)
    const recovered = await recoverTypedDataAddress({
      domain: permit2Domain(CHAIN_ID, PERMIT2),
      types: permit2SingleTypes,
      primaryType: 'PermitWitnessTransferFrom',
      message,
      signature,
    })
    expect(recovered.toLowerCase()).toBe(SIGNER.toLowerCase())
  })
})

/* -------------------------------------------------------------------------- */
/*  Permit2 batch                                                             */
/* -------------------------------------------------------------------------- */

describe('Permit2 batch typed-data — SDK exports vs inline match', () => {
  const message = {
    permitted: [
      { token: CURRENCY, amount: 900_000n },
      { token: CURRENCY, amount: 100_000n },
    ],
    spender: PERMIT2,
    nonce: NONCE,
    deadline: DEADLINE,
    witness: { challengeHash: CHALLENGE_HASH, externalId: EXTERNAL_ID },
  }

  test('hashTypedData identical via Path A vs Path B', () => {
    const hashA = hashTypedData({
      domain: permit2Domain(CHAIN_ID, PERMIT2),
      types: permit2BatchTypes,
      primaryType: 'PermitBatchWitnessTransferFrom',
      message,
    })
    const hashB = hashTypedData({
      domain: INLINE_PERMIT2_DOMAIN,
      types: INLINE_PERMIT2_BATCH_TYPES,
      primaryType: 'PermitBatchWitnessTransferFrom',
      message,
    })
    expect(hashA).toBe(hashB)
  })

  test('sign + recover round-trip recovers SIGNER address', async () => {
    const sigObj = await sign({
      privateKey: PK,
      hash: hashTypedData({
        domain: permit2Domain(CHAIN_ID, PERMIT2),
        types: permit2BatchTypes,
        primaryType: 'PermitBatchWitnessTransferFrom',
        message,
      }),
    })
    const signature = signatureToHex(sigObj)
    const recovered = await recoverTypedDataAddress({
      domain: permit2Domain(CHAIN_ID, PERMIT2),
      types: permit2BatchTypes,
      primaryType: 'PermitBatchWitnessTransferFrom',
      message,
      signature,
    })
    expect(recovered.toLowerCase()).toBe(SIGNER.toLowerCase())
  })
})

/* -------------------------------------------------------------------------- */
/*  EIP-3009 TransferWithAuthorization                                        */
/* -------------------------------------------------------------------------- */

describe('EIP-3009 TransferWithAuthorization — SDK exports vs inline match', () => {
  const NONCE_BYTES32 = eip3009Nonce(CHALLENGE_ID, REALM)
  const VALID_AFTER = 1_900_000_000n
  const VALID_BEFORE = 1_900_001_000n

  const message = {
    from: SIGNER,
    to: RECIPIENT,
    value: AMOUNT,
    validAfter: VALID_AFTER,
    validBefore: VALID_BEFORE,
    nonce: NONCE_BYTES32,
  }

  test('hashTypedData identical via Path A vs Path B (Circle USDC domain)', () => {
    const hashA = hashTypedData({
      domain: eip3009Domain({
        tokenName: 'USD Coin',
        tokenVersion: '2',
        chainId: CHAIN_ID,
        tokenAddress: CURRENCY,
      }),
      types: eip3009Types,
      primaryType: 'TransferWithAuthorization',
      message,
    })
    const hashB = hashTypedData({
      domain: INLINE_EIP3009_DOMAIN_USDC,
      types: INLINE_EIP3009_TYPES,
      primaryType: 'TransferWithAuthorization',
      message,
    })
    expect(hashA).toBe(hashB)
  })

  test('sign + recover round-trip recovers SIGNER address', async () => {
    const sigObj = await sign({
      privateKey: PK,
      hash: hashTypedData({
        domain: eip3009Domain({
          tokenName: 'USD Coin',
          tokenVersion: '2',
          chainId: CHAIN_ID,
          tokenAddress: CURRENCY,
        }),
        types: eip3009Types,
        primaryType: 'TransferWithAuthorization',
        message,
      }),
    })
    const signature = signatureToHex(sigObj)
    const recovered = await recoverTypedDataAddress({
      domain: eip3009Domain({
        tokenName: 'USD Coin',
        tokenVersion: '2',
        chainId: CHAIN_ID,
        tokenAddress: CURRENCY,
      }),
      types: eip3009Types,
      primaryType: 'TransferWithAuthorization',
      message,
      signature,
    })
    expect(recovered.toLowerCase()).toBe(SIGNER.toLowerCase())
  })
})

/* -------------------------------------------------------------------------- */
/*  Negative test — type drift detection                                      */
/* -------------------------------------------------------------------------- */

describe('cross-check catches drift', () => {
  test('renaming a field in inline types produces a DIFFERENT hash', () => {
    // Sanity-check that this test apparatus actually catches drift. If
    // someone "fixes" the cross-check by always returning true, this
    // negative case will start failing.
    const message = {
      permitted: { token: CURRENCY, amount: AMOUNT },
      spender: PERMIT2,
      nonce: NONCE,
      deadline: DEADLINE,
      witness: { challengeHash: CHALLENGE_HASH, externalId: '' },
    }
    const hashSdk = hashTypedData({
      domain: permit2Domain(CHAIN_ID, PERMIT2),
      types: permit2SingleTypes,
      primaryType: 'PermitWitnessTransferFrom',
      message,
    })
    const DRIFTED = {
      ...INLINE_PERMIT2_SINGLE_TYPES,
      // Rename `challengeHash` → `paymentHash`. This is a representative
      // drift bug; the hash MUST change.
      PaymentWitness: [
        { name: 'paymentHash', type: 'bytes32' },
        { name: 'externalId', type: 'string' },
      ],
    } as const
    const hashDrift = hashTypedData({
      domain: INLINE_PERMIT2_DOMAIN,
      types: DRIFTED,
      primaryType: 'PermitWitnessTransferFrom',
      message: {
        ...message,
        witness: { paymentHash: CHALLENGE_HASH, externalId: EXTERNAL_ID },
      },
    })
    expect(hashSdk).not.toBe(hashDrift)
  })
})
