import { x402Client } from '@x402/core/client'
import { x402ResourceServer } from '@x402/core/server'
import type { PaymentRequirements as X402PaymentRequirements } from '@x402/core/types'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vitest'

import { B402ExactClientScheme } from '../client/Scheme.js'
import type { AssetTransferMethod, SupportedResponse } from '../Types.js'
import { B402FacilitatorClient } from './Facilitator.js'
import { B402ExactServerScheme } from './Scheme.js'
import type { B402Transport } from './Types.js'

const network = 'eip155:97' as const
const asset = '0x337610d27c682e347C9cD60BD4b3b107C9d34dDd' as const
const payTo = '0x6ce211911aEF93baE0E01e8AEB053654558b0aec' as const
const providerSigner = '0x5f77eE41BaffDAe61830eF9be76541444FAE5D11' as const
const spender = '0x45481A7FaFc1e62Bb7D851645927E32a2FFA0271' as const
const transaction = `0x${'ab'.repeat(32)}`

describe('official x402 integration', () => {
  test.each(['eip3009', 'permit2-exact'] as const)(
    'runs the %s path through x402Client and x402ResourceServer',
    async (method) => {
      const account = privateKeyToAccount(generatePrivateKey())
      const raw = new FakeTransport(account.address)
      const facilitator = new B402FacilitatorClient({
        bazaar: { info: { route: '/premium' }, schema: { type: 'object' } },
        client: raw,
      })
      const resourceServer = new x402ResourceServer(facilitator).register(
        'eip155:*',
        new B402ExactServerScheme({ facilitator }),
      )
      await resourceServer.initialize()

      const [requirements] = await resourceServer.buildPaymentRequirements({
        extra: {
          assetTransferMethod: method,
          name: method === 'eip3009' ? 'U' : 'USDT Token',
          version: '1',
        },
        network,
        payTo,
        price: { amount: '1000', asset },
        scheme: 'exact',
      })
      expect(requirements?.extra['assetTransferMethod']).toBe(method)

      const client = new x402Client().register(
        'eip155:*',
        new B402ExactClientScheme({
          account,
          methods: [method],
          permit2Allowance: async () => 1000n,
          trustedSpenders: { [network]: [spender] },
        }),
      )
      const payment = await client.createPaymentPayload({
        accepts: [requirements as X402PaymentRequirements],
        resource: { url: 'https://merchant.example/premium' },
        x402Version: 2,
      })
      payment.extensions = { bazaar: { hostile: true } }

      await expect(resourceServer.verifyPayment(payment, requirements!)).resolves.toMatchObject({
        isValid: true,
        payer: account.address,
      })
      await expect(resourceServer.settlePayment(payment, requirements!)).resolves.toMatchObject({
        amount: '1000',
        network,
        payer: account.address,
        success: true,
        transaction,
      })

      expect(raw.lastSettled?.paymentPayload.extensions).toEqual({
        bazaar: { info: { route: '/premium' }, schema: { type: 'object' } },
      })
      expect(raw.lastSettled?.paymentPayload.accepted.extra.assetTransferMethod).toBe(method)
    },
  )
})

class FakeTransport implements B402Transport {
  lastSettled: Parameters<B402Transport['settle']>[0] | undefined

  constructor(readonly payer: `0x${string}`) {}

  async supported(): Promise<SupportedResponse> {
    return {
      extensions: [],
      kinds: [kind('eip3009'), kind('permit2-exact')],
      signers: { 'eip155:*': [providerSigner] },
    }
  }

  async verify() {
    return { isValid: true, payer: this.payer }
  }

  async settle(request: Parameters<B402Transport['settle']>[0]) {
    this.lastSettled = request
    return {
      amount: request.paymentRequirements.amount,
      network: request.paymentRequirements.network,
      payer: this.payer,
      success: true,
      transaction,
    }
  }
}

function kind(method: AssetTransferMethod): SupportedResponse['kinds'][number] {
  return {
    extra: {
      assetTransferMethod: method,
      name: method === 'eip3009' ? 'U' : 'USDT Token',
      signerAddress: providerSigner,
      ...(method === 'permit2-exact' ? { spenderAddress: spender } : {}),
      version: '1',
    },
    network,
    scheme: 'exact',
    x402Version: 2,
  }
}
