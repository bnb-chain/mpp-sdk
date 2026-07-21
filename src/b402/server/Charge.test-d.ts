import { Mppx } from 'mppx/server'
import { test } from 'vitest'

import { charge } from './Charge.js'

test('async b402 server factory preserves concise route options', async () => {
  const method = await charge({
    client: {
      settle: async () => ({
        amount: '1',
        network: 'eip155:56',
        payer: '0x1111111111111111111111111111111111111111',
        success: true,
        transaction: `0x${'12'.repeat(32)}`,
      }),
      supported: async () => ({
        extensions: [],
        kinds: [
          {
            extra: {
              assetTransferMethod: 'eip3009',
              name: 'Token Domain',
              signerAddress: '0x2222222222222222222222222222222222222222',
              version: '1',
            },
            network: 'eip155:56',
            scheme: 'exact',
            x402Version: 2,
          },
        ],
        signers: {},
      }),
      verify: async () => ({
        isValid: true,
        payer: '0x1111111111111111111111111111111111111111',
      }),
    },
    currency: {
      address: '0x3333333333333333333333333333333333333333',
      decimals: 6,
      name: 'Token Domain',
      version: '1',
    },
    network: 'eip155:56',
    recipient: '0x4444444444444444444444444444444444444444',
    transferMethods: ['eip3009'],
  })
  const payments = Mppx.create({
    methods: [method],
    secretKey: 'test-secret-key-that-is-at-least-32-bytes',
  })

  payments.b402.charge({ amount: '0.25', transferMethod: 'eip3009' })
})
