/** Runtime validation for the untrusted b402 response boundary. */

import { describe, expect, test } from 'vitest'

import {
  parsePaymentRequiredBody,
  parseSettleResult,
  parseSupportedResponse,
  parseVerifyResult,
} from './Response.js'

const ADDRESS = '0x1111111111111111111111111111111111111111'

describe('b402 response parsers', () => {
  test('accepts a well-formed /supported response', () => {
    const value = {
      kinds: [
        {
          x402Version: 2,
          scheme: 'exact',
          network: 'eip155:56',
          extra: {
            name: 'United Stables',
            version: '1',
            assetTransferMethod: 'eip3009',
            signerAddress: ADDRESS,
          },
        },
      ],
      extensions: [],
      signers: { 'eip155:*': [ADDRESS] },
    }
    expect(parseSupportedResponse(value)).toEqual(value)
  })

  test('rejects malformed /supported kinds before Gate or Adapter code sees them', () => {
    expect(() =>
      parseSupportedResponse({
        kinds: [
          {
            x402Version: 2,
            scheme: 'exact',
            network: 'eip155:56',
            extra: {
              name: 'United Stables',
              version: '1',
              assetTransferMethod: 'eip3009',
              signerAddress: 'not-an-address',
            },
          },
        ],
        extensions: [],
        signers: {},
      }),
    ).toThrow(/signerAddress/)
  })

  test('filters unsupported upto kinds without widening the public type', () => {
    const parsed = parseSupportedResponse({
      kinds: [
        {
          x402Version: 2,
          scheme: 'upto',
          network: 'eip155:56',
          extra: { assetTransferMethod: 'permit2-upto' },
        },
        {
          x402Version: 2,
          scheme: 'exact',
          network: 'eip155:56',
          extra: {
            name: 'United Stables',
            version: '1',
            assetTransferMethod: 'eip3009',
            signerAddress: ADDRESS,
          },
        },
      ],
      extensions: [],
      signers: {},
    })
    expect(parsed.kinds).toHaveLength(1)
    expect(parsed.kinds[0]?.scheme).toBe('exact')
  })

  test('filters unsupported 402 offers and rejects an upto-only response', () => {
    const exact = {
      scheme: 'exact',
      network: 'eip155:56',
      amount: '1',
      asset: ADDRESS,
      payTo: ADDRESS,
      maxTimeoutSeconds: 300,
      extra: {
        name: 'United Stables',
        version: '1',
        assetTransferMethod: 'eip3009',
        signerAddress: ADDRESS,
      },
    }
    const upto = {
      ...exact,
      scheme: 'upto',
      extra: { assetTransferMethod: 'permit2-upto' },
    }
    expect(parsePaymentRequiredBody({ x402Version: 2, accepts: [upto, exact] }).accepts).toEqual([
      exact,
    ])
    expect(() => parsePaymentRequiredBody({ x402Version: 2, accepts: [upto] })).toThrow(
      /no supported exact/,
    )
  })

  test('accepts valid and rejected /verify responses, but rejects wrong field types', () => {
    expect(parseVerifyResult({ isValid: true, payer: ADDRESS })).toEqual({
      isValid: true,
      payer: ADDRESS,
    })
    expect(
      parseVerifyResult({
        isValid: false,
        payer: '',
        invalidReason: 'signature_invalid',
      }),
    ).toMatchObject({ isValid: false, invalidReason: 'signature_invalid' })
    expect(() => parseVerifyResult({ isValid: 'yes', payer: ADDRESS })).toThrow(/isValid/)
  })

  test('validates /settle wire types without misclassifying incomplete success semantics', () => {
    const incomplete = {
      success: true,
      transaction: '',
      payer: ADDRESS,
      network: 'eip155:56',
    }
    expect(parseSettleResult(incomplete)).toEqual(incomplete)
    expect(() => parseSettleResult({ ...incomplete, amount: 1 })).toThrow(/amount/)
    expect(() => parseSettleResult({ ...incomplete, transaction: 123 })).toThrow(/transaction/)
  })
})
