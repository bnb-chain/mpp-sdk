/**
 * b402 browser-safe payload helpers.
 *
 *   1. buildEip3009Payment signs typed data that recovers to the signer
 *   2. the authorization fields mirror the requirements (to/value/from/window)
 *   3. encodeXPayment / decodeXPayment round-trip
 *   4. isEip3009PaymentPayload validates the full exact/eip3009/v2 shape +
 *      wire format (not just the shallow authorization-field presence)
 *   5. buildEip3009Payment rejects a non-eip3009 method AND a non-exact scheme
 *   6. chainIdFromNetwork parses CAIP-2; randomB402Nonce is a 32-byte hex
 */

import { getAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vitest'

import {
  buildEip3009Payment,
  chainIdFromNetwork,
  decodeXPayment,
  decodeXPaymentResponse,
  encodeXPayment,
  encodeXPaymentResponse,
  isEip3009PaymentPayload,
  randomB402Nonce,
  recoverEip3009Payer,
} from './Payload.js'
import type { PaymentRequirements, SettleResult } from './Types.js'

function eip3009Requirements(): PaymentRequirements {
  return {
    scheme: 'exact',
    network: 'eip155:97',
    amount: '1000000',
    asset: privateKeyToAccount(generatePrivateKey()).address,
    payTo: privateKeyToAccount(generatePrivateKey()).address,
    maxTimeoutSeconds: 300,
    extra: {
      name: 'U',
      version: '1',
      assetTransferMethod: 'eip3009',
      signerAddress: '0x1111111111111111111111111111111111111111',
    },
  }
}

describe('buildEip3009Payment', () => {
  test('signs typed data that recoverEip3009Payer resolves to the payer', async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const payload = await buildEip3009Payment({ account, requirements: eip3009Requirements() })
    expect(getAddress(await recoverEip3009Payer(payload))).toBe(account.address)
  })

  test('mirrors the requirements in the authorization', async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const requirements = eip3009Requirements()
    const before = Math.floor(Date.now() / 1000)

    const { authorization } = (await buildEip3009Payment({ account, requirements })).payload

    expect(authorization.from).toBe(account.address)
    expect(authorization.to).toBe(requirements.payTo)
    expect(authorization.value).toBe(requirements.amount)
    expect(authorization.validAfter).toBe('0')
    expect(Number(authorization.validBefore)).toBeGreaterThanOrEqual(
      before + requirements.maxTimeoutSeconds,
    )
    expect(authorization.nonce).toMatch(/^0x[0-9a-f]{64}$/)
  })

  test('uses a caller-supplied binding nonce verbatim', async () => {
    const nonce = `0x${'42'.repeat(32)}` as const
    const payment = await buildEip3009Payment({
      account: privateKeyToAccount(generatePrivateKey()),
      nonce,
      requirements: eip3009Requirements(),
    })
    expect(payment.payload.authorization.nonce).toBe(nonce)
  })

  test('rejects a non-eip3009 asset-transfer method', async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const requirements = eip3009Requirements()
    const permit2 = {
      ...requirements,
      extra: { ...requirements.extra, assetTransferMethod: 'permit2-exact' as const },
    }
    await expect(buildEip3009Payment({ account, requirements: permit2 })).rejects.toThrow(/eip3009/)
  })

  test('rejects a non-exact scheme (only exact is modeled)', async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const upto = { ...eip3009Requirements(), scheme: 'upto' as const }
    await expect(
      buildEip3009Payment({
        account,
        requirements: upto as unknown as ReturnType<typeof eip3009Requirements>,
      }),
    ).rejects.toThrow(/scheme 'upto'|only 'exact'/)
  })
})

describe('X-PAYMENT codec', () => {
  test('encode → decode round-trips', async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const payload = await buildEip3009Payment({
      account,
      requirements: eip3009Requirements(),
      resourceUrl: 'https://api.example.com/premium',
    })
    expect(decodeXPayment(encodeXPayment(payload))).toEqual(payload)
  })
})

describe('X-PAYMENT-RESPONSE codec', () => {
  const settlement: SettleResult = {
    success: true,
    transaction: '0x89c91c789e57059b17285e7ba1716a1f5ff4c5dace0ea5a5135f26158d0421b9',
    payer: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
    network: 'eip155:97',
    amount: '1000000',
  }

  test('encode → decode round-trips', () => {
    expect(decodeXPaymentResponse(encodeXPaymentResponse(settlement))).toEqual(settlement)
  })

  test('returns undefined for an absent or malformed header', () => {
    expect(decodeXPaymentResponse(null)).toBeUndefined()
    expect(decodeXPaymentResponse('not base64 json!!')).toBeUndefined()
  })
})

describe('isEip3009PaymentPayload', () => {
  test('accepts a well-formed payload', async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const good = await buildEip3009Payment({ account, requirements: eip3009Requirements() })
    expect(isEip3009PaymentPayload(good)).toBe(true)
  })

  test('rejects structural gaps', () => {
    expect(isEip3009PaymentPayload(null)).toBe(false)
    expect(isEip3009PaymentPayload({})).toBe(false)
    expect(isEip3009PaymentPayload({ x402Version: 2, accepted: {} })).toBe(false)
    expect(isEip3009PaymentPayload({ payload: { signature: '0x', authorization: {} } })).toBe(false)
  })

  test('rejects attacker shapes the old shallow guard would have PASSED', async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const good = await buildEip3009Payment({ account, requirements: eip3009Requirements() })
    const withAccepted = (over: Record<string, unknown>): unknown => ({
      ...good,
      accepted: { ...good.accepted, ...over },
    })
    const withExtra = (over: Record<string, unknown>): unknown => ({
      ...good,
      accepted: { ...good.accepted, extra: { ...good.accepted.extra, ...over } },
    })
    const withAuth = (over: Record<string, unknown>): unknown => ({
      ...good,
      payload: { ...good.payload, authorization: { ...good.payload.authorization, ...over } },
    })

    // envelope — wrong version / scheme / method
    expect(isEip3009PaymentPayload({ ...good, x402Version: 1 })).toBe(false)
    expect(isEip3009PaymentPayload(withAccepted({ scheme: 'upto' }))).toBe(false)
    expect(isEip3009PaymentPayload(withExtra({ assetTransferMethod: 'permit2-exact' }))).toBe(false)

    // accepted fields recoverEip3009Payer reads — bad format
    expect(isEip3009PaymentPayload(withAccepted({ network: 'solana:mainnet' }))).toBe(false)
    expect(isEip3009PaymentPayload(withAccepted({ asset: '0xnothex' }))).toBe(false)
    expect(isEip3009PaymentPayload(withAccepted({ amount: '1.5' }))).toBe(false)
    expect(isEip3009PaymentPayload(withAccepted({ maxTimeoutSeconds: '300' }))).toBe(false) // string
    expect(isEip3009PaymentPayload(withAccepted({ maxTimeoutSeconds: 0 }))).toBe(false) // non-positive
    expect(isEip3009PaymentPayload(withExtra({ name: 123 }))).toBe(false)
    expect(isEip3009PaymentPayload(withExtra({ signerAddress: 'not-an-address' }))).toBe(false)

    // authorization / signature shape
    expect(
      isEip3009PaymentPayload({ ...good, payload: { ...good.payload, signature: '0xdead' } }),
    ).toBe(false)
    expect(isEip3009PaymentPayload(withAuth({ nonce: '0x1234' }))).toBe(false) // not 32 bytes
    expect(isEip3009PaymentPayload(withAuth({ from: 'not-an-address' }))).toBe(false)
    expect(isEip3009PaymentPayload(withAuth({ value: 'abc' }))).toBe(false)
  })
})

describe('helpers', () => {
  test('chainIdFromNetwork parses CAIP-2 and rejects junk', () => {
    expect(chainIdFromNetwork('eip155:56')).toBe(56)
    expect(chainIdFromNetwork('eip155:97')).toBe(97)
    expect(() => chainIdFromNetwork('solana:mainnet')).toThrow()
    expect(() => chainIdFromNetwork('eip155:')).toThrow()
  })

  test('randomB402Nonce is a distinct 32-byte hex', () => {
    const a = randomB402Nonce()
    const b = randomB402Nonce()
    expect(a).toMatch(/^0x[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
  })
})
