import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vitest'

import type { FacilitatorRequest } from './Client.js'
import { type B402ExactClient, createFixedB402ExactHandler } from './Exact.js'
import { buildEip3009Payment, encodeXPayment } from './Payload.js'
import { CURATED_B402_SPENDERS, buildPermit2ExactPayment } from './Permit2.js'
import type { PaymentRequiredBody, SettleResult, SupportedResponse } from './Types.js'

const NETWORK = 'eip155:97'
const ASSET = '0x337610d27c682E347C9cD60BD4b3b107C9d34dDd' as const
const PAY_TO = '0x2222222222222222222222222222222222222222' as const
const SIGNER = '0x5f77eE41BaffDAe61830eF9be76541444FAE5D11' as const
const SPENDER = CURATED_B402_SPENDERS[NETWORK]!.exact

const SUPPORTED: SupportedResponse = {
  kinds: [
    {
      x402Version: 2,
      scheme: 'exact',
      network: NETWORK,
      extra: {
        name: 'USDT Token',
        version: '1',
        assetTransferMethod: 'eip3009',
        signerAddress: SIGNER,
      },
    },
    {
      x402Version: 2,
      scheme: 'exact',
      network: NETWORK,
      extra: {
        name: 'USDT Token',
        version: '1',
        assetTransferMethod: 'permit2-exact',
        signerAddress: SIGNER,
        spenderAddress: SPENDER,
      },
    },
  ],
  extensions: [],
  signers: { 'eip155:*': [SIGNER] },
}

function payerOf(request: FacilitatorRequest): string {
  const payload = request.paymentPayload.payload
  return 'authorization' in payload ? payload.authorization.from : payload.permit2Authorization.from
}

function fakeClient(): {
  client: B402ExactClient
  verify: FacilitatorRequest[]
  settle: FacilitatorRequest[]
} {
  const verify: FacilitatorRequest[] = []
  const settle: FacilitatorRequest[] = []
  return {
    verify,
    settle,
    client: {
      supported: () => Promise.resolve(SUPPORTED),
      verify: (request) => {
        verify.push(request)
        return Promise.resolve({ isValid: true, payer: payerOf(request) })
      },
      settle: (request) => {
        settle.push(request)
        return Promise.resolve({
          success: true,
          transaction: `0x${'ab'.repeat(32)}`,
          payer: payerOf(request),
          network: request.paymentRequirements.network,
          amount: request.paymentRequirements.amount,
        })
      },
    },
  }
}

function options(client: B402ExactClient) {
  return {
    client,
    network: NETWORK,
    asset: { address: ASSET, name: 'USDT Token' },
    payTo: PAY_TO,
    amount: '5000000',
  }
}

describe('createFixedB402ExactHandler', () => {
  test('advertises EIP-3009 and Permit2 Exact in configured preference order', async () => {
    const { client } = fakeClient()
    const handler = await createFixedB402ExactHandler(options(client))
    const result = await handler(new Request('https://merchant.example/report'))
    expect(result.paid).toBe(false)
    if (result.paid) throw new Error('unreachable')
    const body = (await result.response.json()) as PaymentRequiredBody
    expect(body.accepts.map((entry) => entry.extra.assetTransferMethod)).toEqual([
      'eip3009',
      'permit2-exact',
    ])
  })

  test('settles EIP-3009 and strips buyer-owned metadata before merchant authentication', async () => {
    const { client, verify, settle } = fakeClient()
    const handler = await createFixedB402ExactHandler(options(client))
    const requirements = handler.requirements.find(
      (entry) => entry.extra.assetTransferMethod === 'eip3009',
    )!
    const account = privateKeyToAccount(generatePrivateKey())
    const payment = await buildEip3009Payment({ account, requirements })
    const hostile = {
      ...payment,
      resource: { url: 'https://evil.example' },
      extensions: { bazaar: { description: 'attacker' } },
    }

    const result = await handler(
      new Request('https://merchant.example/report', {
        headers: { 'X-PAYMENT': encodeXPayment(hostile) },
      }),
    )
    expect(result.paid).toBe(true)
    if (!result.paid) throw new Error('unreachable')
    expect(result.method).toBe('eip3009')
    for (const call of [...verify, ...settle]) {
      expect('resource' in call.paymentPayload).toBe(false)
      expect('extensions' in call.paymentPayload).toBe(false)
      expect(call.paymentPayload.accepted).toBe(requirements)
    }
  })

  test('rejects an EIP-3009 authorization whose signed amount drifts from accepted', async () => {
    const { client, verify, settle } = fakeClient()
    const handler = await createFixedB402ExactHandler(options(client))
    const requirements = handler.requirements.find(
      (entry) => entry.extra.assetTransferMethod === 'eip3009',
    )!
    const account = privateKeyToAccount(generatePrivateKey())
    const payment = await buildEip3009Payment({ account, requirements })
    const hostile = structuredClone(payment)
    ;(hostile.payload.authorization as { value: string }).value = '1'

    const result = await handler(
      new Request('https://merchant.example/report', {
        headers: { 'X-PAYMENT': encodeXPayment(hostile) },
      }),
    )
    expect(result.paid).toBe(false)
    if (result.paid) throw new Error('unreachable')
    expect(result.response.status).toBe(400)
    expect(verify).toHaveLength(0)
    expect(settle).toHaveLength(0)
  })

  test('turns a truncated accepted object into 400 instead of throwing', async () => {
    const { client, verify } = fakeClient()
    const handler = await createFixedB402ExactHandler(options(client))
    const result = await handler(
      new Request('https://merchant.example/report', {
        headers: {
          'X-PAYMENT': encodeXPayment({
            x402Version: 2,
            accepted: {} as never,
            payload: {} as never,
          }),
        },
      }),
    )
    expect(result.paid).toBe(false)
    if (result.paid) throw new Error('unreachable')
    expect(result.response.status).toBe(400)
    expect(verify).toHaveLength(0)
  })

  test('still accepts Permit2 Exact through the same handler', async () => {
    const { client } = fakeClient()
    const handler = await createFixedB402ExactHandler(options(client))
    const requirements = handler.requirements.find(
      (entry) => entry.extra.assetTransferMethod === 'permit2-exact',
    )!
    const account = privateKeyToAccount(generatePrivateKey())
    const payment = await buildPermit2ExactPayment({
      account,
      requirements,
      trustedSpenders: [SPENDER],
    })
    const result = await handler(
      new Request('https://merchant.example/report', {
        headers: { 'X-PAYMENT': encodeXPayment(payment) },
      }),
    )
    expect(result.paid).toBe(true)
    if (!result.paid) throw new Error('unreachable')
    expect(result.method).toBe('permit2-exact')
  })

  test('does not unlock content when B402 returns an incomplete success', async () => {
    const fake = fakeClient()
    fake.client.settle = (request) =>
      Promise.resolve({
        success: true,
        transaction: '',
        payer: payerOf(request),
        network: NETWORK,
        amount: '5000000',
      } satisfies SettleResult)
    const handler = await createFixedB402ExactHandler(options(fake.client))
    const requirements = handler.requirements[0]!
    const payment = await buildEip3009Payment({
      account: privateKeyToAccount(generatePrivateKey()),
      requirements,
    })
    const result = await handler(
      new Request('https://merchant.example/report', {
        headers: { 'X-PAYMENT': encodeXPayment(payment) },
      }),
    )
    expect(result.paid).toBe(false)
    if (result.paid) throw new Error('unreachable')
    expect(result.settlement?.status).toBe('unknown')
  })
})
