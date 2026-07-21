import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vitest'

import { B402Permit2ApprovalRequiredError, createB402PaymentClient } from './Buyer.js'
import { decodeXPayment, encodeXPaymentResponse } from './Payload.js'
import { CURATED_B402_SPENDERS } from './Permit2.js'
import type { PaymentRequiredBody, PaymentRequirements } from './Types.js'

const NETWORK = 'eip155:97'
const ASSET = '0x337610d27c682E347C9cD60BD4b3b107C9d34dDd' as const
const PAY_TO = '0x2222222222222222222222222222222222222222' as const
const SIGNER = '0x5f77eE41BaffDAe61830eF9be76541444FAE5D11' as const
const SPENDER = CURATED_B402_SPENDERS[NETWORK]!.exact

function requirements(method: 'eip3009' | 'permit2-exact'): PaymentRequirements {
  return {
    scheme: 'exact',
    network: NETWORK,
    amount: '5000000',
    asset: ASSET,
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: {
      name: 'USDT Token',
      version: '1',
      assetTransferMethod: method,
      signerAddress: SIGNER,
      ...(method === 'permit2-exact' ? { spenderAddress: SPENDER } : {}),
    },
  }
}

function paymentFetch(accepts: readonly PaymentRequirements[]): {
  fetch: typeof fetch
  calls: RequestInit[]
} {
  const calls: RequestInit[] = []
  const fetcher: typeof fetch = async (_input, init) => {
    calls.push(init ?? {})
    if (calls.length === 1) {
      return new Response(
        JSON.stringify({ x402Version: 2, accepts } satisfies PaymentRequiredBody),
        { status: 402, headers: { 'Content-Type': 'application/json' } },
      )
    }
    const header = new Headers(init?.headers).get('X-PAYMENT')
    if (!header) throw new Error('missing X-PAYMENT')
    const payment = decodeXPayment(header)
    const payer =
      'authorization' in payment.payload
        ? payment.payload.authorization.from
        : payment.payload.permit2Authorization.from
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'X-PAYMENT-RESPONSE': encodeXPaymentResponse({
          success: true,
          transaction: `0x${'ab'.repeat(32)}`,
          payer,
          network: payment.accepted.network,
          amount: payment.accepted.amount,
        }),
      },
    })
  }
  return { fetch: fetcher, calls }
}

describe('createB402PaymentClient', () => {
  test('prefers EIP-3009 and completes probe/sign/retry without Permit2 configuration', async () => {
    const fake = paymentFetch([requirements('permit2-exact'), requirements('eip3009')])
    const client = createB402PaymentClient({
      account: privateKeyToAccount(generatePrivateKey()),
      methods: ['eip3009', 'permit2-exact'],
      fetch: fake.fetch,
    })
    const result = await client.pay('https://merchant.example/report')
    expect(result.paymentMade).toBe(true)
    if (!result.paymentMade) throw new Error('unreachable')
    expect(result.method).toBe('eip3009')
    expect(result.settlement?.success).toBe(true)
    expect(fake.calls).toHaveLength(2)
  })

  test('raises an explicit approval request before signing/sending Permit2 Exact', async () => {
    const fake = paymentFetch([requirements('permit2-exact')])
    const client = createB402PaymentClient({
      account: privateKeyToAccount(generatePrivateKey()),
      methods: ['permit2-exact'],
      trustedSpenders: { [NETWORK]: [SPENDER] },
      permit2Allowance: () => 0n,
      fetch: fake.fetch,
    })
    const error = await client.pay('https://merchant.example/report').catch((cause) => cause)
    expect(error).toBeInstanceOf(B402Permit2ApprovalRequiredError)
    expect((error as B402Permit2ApprovalRequiredError).approval).toMatchObject({
      network: NETWORK,
      token: ASSET,
      requiredAmount: 5000000n,
      currentAllowance: 0n,
    })
    expect(fake.calls).toHaveLength(1)
  })

  test('pays with Permit2 Exact after allowance and trusted-spender checks pass', async () => {
    const fake = paymentFetch([requirements('permit2-exact')])
    const client = createB402PaymentClient({
      account: privateKeyToAccount(generatePrivateKey()),
      methods: ['permit2-exact'],
      trustedSpenders: { [NETWORK]: [SPENDER] },
      permit2Allowance: () => 5000000n,
      fetch: fake.fetch,
    })
    const result = await client.pay('https://merchant.example/report')
    expect(result.paymentMade).toBe(true)
    if (!result.paymentMade) throw new Error('unreachable')
    expect(result.method).toBe('permit2-exact')
    expect(fake.calls).toHaveLength(2)
  })

  test('does not discard paid content when the optional settlement header is malformed', async () => {
    let calls = 0
    const fetcher: typeof fetch = async (_input, init) => {
      calls += 1
      if (calls === 1) {
        return new Response(
          JSON.stringify({
            x402Version: 2,
            accepts: [requirements('eip3009')],
          } satisfies PaymentRequiredBody),
          { status: 402 },
        )
      }
      expect(new Headers(init?.headers).has('X-PAYMENT')).toBe(true)
      return new Response('paid content', {
        status: 200,
        headers: { 'X-PAYMENT-RESPONSE': btoa('{"success":"wrong-type"}') },
      })
    }
    const client = createB402PaymentClient({
      account: privateKeyToAccount(generatePrivateKey()),
      methods: ['eip3009'],
      fetch: fetcher,
    })
    const result = await client.pay('https://merchant.example/report')
    expect(result.paymentMade).toBe(true)
    if (!result.paymentMade) throw new Error('unreachable')
    expect(result.settlement).toBeUndefined()
    expect(await result.response.text()).toBe('paid content')
  })
})
