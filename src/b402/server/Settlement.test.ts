import { describe, expect, test } from 'vitest'

import type { FacilitatorRequest } from '../Client.js'
import type { PaymentRequirements } from '../Types.js'
import { B402SettlementUnknownError, settleB402 } from './Settlement.js'

const PAYER = '0x3333333333333333333333333333333333333333'
const TX_HASH = `0x${'ab'.repeat(32)}`
const requirements: PaymentRequirements = {
  amount: '5000000',
  asset: '0x1111111111111111111111111111111111111111',
  extra: {
    assetTransferMethod: 'eip3009',
    name: 'Token Domain',
    signerAddress: '0x4444444444444444444444444444444444444444',
    version: '1',
  },
  maxTimeoutSeconds: 300,
  network: 'eip155:56',
  payTo: '0x2222222222222222222222222222222222222222',
  scheme: 'exact',
}
const request = {
  paymentPayload: {
    accepted: requirements,
    payload: {
      authorization: {
        from: PAYER,
        nonce: `0x${'12'.repeat(32)}`,
        to: requirements.payTo,
        validAfter: '0',
        validBefore: '9999999999',
        value: requirements.amount,
      },
      signature: `0x${'34'.repeat(65)}`,
    },
    x402Version: 2,
  },
  paymentRequirements: requirements,
  x402Version: 2,
} satisfies FacilitatorRequest

const expectation = { payer: PAYER, requirements, transferMethod: 'eip3009' as const }

describe('settleB402', () => {
  test('returns a fully matched success', async () => {
    await expect(
      settleB402({
        client: {
          settle: async () => ({
            amount: requirements.amount,
            network: requirements.network,
            payer: PAYER,
            success: true,
            transaction: TX_HASH,
          }),
        },
        expectation,
        request,
      }),
    ).resolves.toMatchObject({ success: true, transaction: TX_HASH })
  })

  test('keeps a definitive provider rejection distinct from unknown', async () => {
    await expect(
      settleB402({
        client: {
          settle: async () => ({
            errorReason: 'insufficient_allowance',
            network: requirements.network,
            payer: PAYER,
            success: false,
            transaction: '',
          }),
        },
        expectation,
        request,
      }),
    ).resolves.toMatchObject({ errorReason: 'insufficient_allowance', success: false })
  })

  test.each([
    ['transaction', { transaction: '0x1234' }],
    ['amount', { amount: '1' }],
    ['network', { network: 'eip155:97' }],
    ['payer', { payer: '0x5555555555555555555555555555555555555555' }],
  ] as const)('classifies a mismatched success %s as unknown', async (_field, override) => {
    const events: unknown[] = []
    await expect(
      settleB402({
        client: {
          settle: async () => ({
            amount: requirements.amount,
            network: requirements.network,
            payer: PAYER,
            success: true,
            transaction: TX_HASH,
            ...override,
          }),
        },
        expectation,
        onSettlementUnknown(event) {
          events.push(event)
        },
        request,
      }),
    ).rejects.toBeInstanceOf(B402SettlementUnknownError)
    expect(events).toHaveLength(1)
  })

  test('preserves the typed unknown when the application callback fails', async () => {
    await expect(
      settleB402({
        client: { settle: async () => Promise.reject(new Error('connection reset')) },
        expectation,
        onSettlementUnknown: () => Promise.reject(new Error('queue unavailable')),
        request,
      }),
    ).rejects.toBeInstanceOf(B402SettlementUnknownError)
  })
})
