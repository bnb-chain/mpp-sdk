import { describe, expect, test } from 'vitest'

import { chargeMethod } from './Methods.js'

const CURRENCY = '0x1111111111111111111111111111111111111111'
const RECIPIENT = '0x2222222222222222222222222222222222222222'
const SIGNER = '0x3333333333333333333333333333333333333333'
const SPENDER = '0x4444444444444444444444444444444444444444'

function request(transferMethod: 'eip3009' | 'permit2-exact') {
  return {
    amount: '1.25',
    currency: CURRENCY,
    decimals: 6,
    maxTimeoutSeconds: 300,
    network: 'eip155:56',
    providerSnapshots: {
      eip3009: { signerAddress: SIGNER },
      permit2Exact: { signerAddress: SIGNER, spenderAddress: SPENDER },
    },
    recipient: RECIPIENT,
    tokenName: 'Token Domain',
    tokenVersion: '1',
    transferMethod,
  } as const
}

describe('b402 charge Method', () => {
  test.each(['eip3009', 'permit2-exact'] as const)(
    'normalizes the %s route input into a provider-pinned wire request',
    (transferMethod) => {
      const parsed = chargeMethod.schema.request.parse({
        ...request(transferMethod),
        ignoredServerField: 'must not cross the wire',
      })

      expect(parsed.amount).toBe('1250000')
      expect(parsed).not.toHaveProperty('providerSnapshot')
      expect(parsed).not.toHaveProperty('providerSnapshots')
      expect(parsed).not.toHaveProperty('ignoredServerField')
      expect(parsed.methodDetails).toMatchObject({
        assetTransferMethod: transferMethod,
        network: 'eip155:56',
        signerAddress: SIGNER,
      })
    },
  )

  test('requires the B402 proxy spender for permit2-exact', () => {
    expect(() =>
      chargeMethod.schema.request.parse({
        ...request('permit2-exact'),
        providerSnapshots: { permit2Exact: { signerAddress: SIGNER } },
      }),
    ).toThrow(/spenderAddress/)
  })

  test('rejects zero and negative display amounts after normalization', () => {
    expect(() => chargeMethod.schema.request.parse({ ...request('eip3009'), amount: '0' })).toThrow(
      /positive/,
    )
    expect(() =>
      chargeMethod.schema.request.parse({ ...request('eip3009'), amount: '-1' }),
    ).toThrow(/amount/i)
  })
})
