/**
 * createPermit2ExactX402Gate — the one-call standalone-x402 merchant recipe.
 *
 *   1. creation resolves the permit2-exact kind from /supported (echoes extra
 *      verbatim) and FAILS AT BOOT on a missing kind
 *   2. no X-PAYMENT → 402 + accepts[] menu
 *   3. attacker-controlled X-PAYMENT: malformed → 400 before any facilitator
 *      call; a well-formed payload for DIFFERENT requirements → 400
 *   4. verify / settle rejections → 402 replaying the accepts[] menu
 *   5. happy path → paid:true + X-PAYMENT-RESPONSE decodes to the settle echo
 */

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vitest'

import type { FacilitatorRequest } from './Client.js'
import {
  createDynamicPermit2ExactX402Gate,
  createPermit2ExactX402Gate,
  createX402Gate,
  type X402GateClient,
} from './Gate.js'
import { decodeXPaymentResponse, encodeXPayment } from './Payload.js'
import { CURATED_B402_SPENDERS, buildPermit2ExactPayment } from './Permit2.js'
import type { PaymentRequiredBody, SettleResult, SupportedResponse, VerifyResult } from './Types.js'

const NETWORK = 'eip155:97'
const SPENDER = CURATED_B402_SPENDERS[NETWORK]!.exact
const ASSET = '0x337610d27c682E347C9cD60BD4b3b107C9d34dDd' as const
const PAY_TO = '0x2222222222222222222222222222222222222222' as const

const KIND_EXTRA = {
  name: 'USDT Token',
  version: '1',
  assetTransferMethod: 'permit2-exact',
  signerAddress: '0x5f77eE41BaffDAe61830eF9be76541444FAE5D11',
  spenderAddress: SPENDER,
} as const

const SUPPORTED: SupportedResponse = {
  kinds: [
    // Decoys the resolver must skip: wrong method / wrong name.
    {
      x402Version: 2,
      scheme: 'exact',
      network: NETWORK,
      extra: { ...KIND_EXTRA, assetTransferMethod: 'eip3009' },
    },
    {
      x402Version: 2,
      scheme: 'exact',
      network: NETWORK,
      extra: { ...KIND_EXTRA, name: 'USD Coin' },
    },
    { x402Version: 2, scheme: 'exact', network: NETWORK, extra: KIND_EXTRA },
  ],
  extensions: [],
  signers: { 'eip155:*': [KIND_EXTRA.signerAddress] },
}

interface FakeCalls {
  supported: number
  verify: FacilitatorRequest[]
  settle: FacilitatorRequest[]
}

function fakeClient(over: { verify?: VerifyResult; settle?: SettleResult }): {
  client: X402GateClient
  calls: FakeCalls
} {
  const calls: FakeCalls = { supported: 0, verify: [], settle: [] }
  const client: X402GateClient = {
    supported: () => {
      calls.supported += 1
      return Promise.resolve(SUPPORTED)
    },
    verify: (r) => {
      calls.verify.push(r)
      const payer = (r.paymentPayload.payload as { permit2Authorization: { from: string } })
        .permit2Authorization.from
      return Promise.resolve(over.verify ?? { isValid: true, payer })
    },
    settle: (r) => {
      calls.settle.push(r)
      const payer = (r.paymentPayload.payload as { permit2Authorization: { from: string } })
        .permit2Authorization.from
      return Promise.resolve(
        over.settle ?? {
          success: true,
          transaction: `0x${'ab'.repeat(32)}`,
          payer,
          network: NETWORK,
          amount: '5000000',
        },
      )
    },
  }
  return { client, calls }
}

function gateOptions(client: X402GateClient) {
  return {
    client,
    network: NETWORK,
    asset: { address: ASSET, name: 'USDT Token' },
    payTo: PAY_TO,
    amount: '5000000',
  }
}

/** Sign a payload that matches the gate's advertised requirements. */
async function signedHeader(requirements: PaymentRequiredBody['accepts'][number]): Promise<string> {
  const account = privateKeyToAccount(generatePrivateKey())
  const payment = await buildPermit2ExactPayment({
    account,
    requirements,
    trustedSpenders: [SPENDER],
  })
  return encodeXPayment(payment)
}

describe('createPermit2ExactX402Gate — creation', () => {
  test('the explicit Permit2 name and the compatibility alias build the same gate shape', async () => {
    const { client } = fakeClient({})
    const [explicit, compatibility] = await Promise.all([
      createPermit2ExactX402Gate(gateOptions(client)),
      createX402Gate(gateOptions(client)),
    ])
    expect(explicit.requirements).toEqual(compatibility.requirements)
  })

  test('resolves the permit2-exact kind and echoes its extra verbatim', async () => {
    const { client } = fakeClient({})
    const gate = await createPermit2ExactX402Gate(gateOptions(client))
    expect(gate.requirements.extra).toEqual(KIND_EXTRA)
    expect(gate.requirements.scheme).toBe('exact')
    expect(gate.requirements.asset).toBe(ASSET)
  })

  test('fails AT BOOT when /supported has no matching kind (config error)', async () => {
    const { client } = fakeClient({})
    await expect(
      createPermit2ExactX402Gate({
        ...gateOptions(client),
        asset: { address: ASSET, name: 'USDT' },
      }),
    ).rejects.toThrow(/no exact\/permit2-exact kind named 'USDT'/)
    await expect(
      createPermit2ExactX402Gate({ ...gateOptions(client), network: 'eip155:1' }),
    ).rejects.toThrow(/eip155:1/)
  })

  test('rejects a non-integer amount at creation', async () => {
    const { client } = fakeClient({})
    await expect(
      createPermit2ExactX402Gate({ ...gateOptions(client), amount: '0.01' }),
    ).rejects.toThrow(/atomic units/)
    await expect(
      createPermit2ExactX402Gate({ ...gateOptions(client), amount: '0' }),
    ).rejects.toThrow(/atomic units/)
  })
})

describe('createPermit2ExactX402Gate — request handling', () => {
  test('no X-PAYMENT → 402 with the accepts[] menu', async () => {
    const { client, calls } = fakeClient({})
    const gate = await createPermit2ExactX402Gate(gateOptions(client))
    const result = await gate(new Request('http://x/premium'))
    expect(result.paid).toBe(false)
    if (result.paid) throw new Error('unreachable')
    expect(result.response.status).toBe(402)
    const body = (await result.response.json()) as PaymentRequiredBody
    expect(body.x402Version).toBe(2)
    expect(body.accepts).toEqual([gate.requirements])
    expect(calls.verify).toHaveLength(0)
  })

  test('malformed X-PAYMENT → 400 BEFORE any facilitator call', async () => {
    const { client, calls } = fakeClient({})
    const gate = await createPermit2ExactX402Gate(gateOptions(client))
    for (const header of ['%%%not-base64%%%', btoa('{"x402Version":2}')]) {
      const result = await gate(
        new Request('http://x/premium', { headers: { 'X-PAYMENT': header } }),
      )
      expect(result.paid).toBe(false)
      if (result.paid) throw new Error('unreachable')
      expect(result.response.status).toBe(400)
    }
    expect(calls.verify).toHaveLength(0)
    expect(calls.settle).toHaveLength(0)
  })

  test("a well-formed payload for DIFFERENT requirements → 400 (pinned to the gate's offer)", async () => {
    const { client, calls } = fakeClient({})
    const gate = await createPermit2ExactX402Gate(gateOptions(client))
    // Signed against a different payTo — internally consistent, wrong offer.
    const header = await signedHeader({
      ...gate.requirements,
      payTo: '0x9999999999999999999999999999999999999999',
    })
    const result = await gate(new Request('http://x/premium', { headers: { 'X-PAYMENT': header } }))
    expect(result.paid).toBe(false)
    if (result.paid) throw new Error('unreachable')
    expect(result.response.status).toBe(400)
    expect(calls.verify).toHaveLength(0)
  })

  test('SECURITY: every server-owned requirement field is pinned before facilitator calls', async () => {
    const mutations: Array<(requirements: PaymentRequiredBody['accepts'][number]) => void> = [
      (r) => {
        ;(r as { maxTimeoutSeconds: number }).maxTimeoutSeconds += 1
      },
      (r) => {
        ;(r.extra as { name: string }).name = 'Attacker Token'
      },
      (r) => {
        ;(r.extra as { version: string }).version = '999'
      },
      (r) => {
        ;(r.extra as { signerAddress: string }).signerAddress =
          '0x9999999999999999999999999999999999999999'
      },
    ]

    for (const mutate of mutations) {
      const { client, calls } = fakeClient({})
      const gate = await createPermit2ExactX402Gate(gateOptions(client))
      const account = privateKeyToAccount(generatePrivateKey())
      const payment = await buildPermit2ExactPayment({
        account,
        requirements: gate.requirements,
        trustedSpenders: [SPENDER],
      })
      // The builder intentionally references the provided requirements object;
      // model a real HTTP attacker by cloning across the JSON boundary before
      // mutating, so the gate's server-owned object remains unchanged.
      const hostile = structuredClone(payment)
      mutate(hostile.accepted)

      const result = await gate(
        new Request('http://x/premium', {
          headers: { 'X-PAYMENT': encodeXPayment(hostile) },
        }),
      )
      expect(result.paid).toBe(false)
      if (result.paid) throw new Error('unreachable')
      expect(result.response.status).toBe(400)
      expect(calls.verify).toHaveLength(0)
      expect(calls.settle).toHaveLength(0)
    }
  })

  test('verify rejection → 402 replaying the menu, settle NOT called', async () => {
    const { client, calls } = fakeClient({
      verify: { isValid: false, payer: '', invalidReason: 'signature_invalid' },
    })
    const gate = await createPermit2ExactX402Gate(gateOptions(client))
    const header = await signedHeader(gate.requirements)
    const result = await gate(new Request('http://x/premium', { headers: { 'X-PAYMENT': header } }))
    expect(result.paid).toBe(false)
    if (result.paid) throw new Error('unreachable')
    expect(result.response.status).toBe(402)
    const body = (await result.response.json()) as PaymentRequiredBody
    expect(body.error).toMatch(/signature_invalid/)
    expect(body.accepts).toEqual([gate.requirements])
    expect(calls.settle).toHaveLength(0)
  })

  test('verify success for a DIFFERENT payer → 502 and settle NOT called', async () => {
    const { client, calls } = fakeClient({
      verify: {
        isValid: true,
        payer: '0x9999999999999999999999999999999999999999',
      },
    })
    const gate = await createPermit2ExactX402Gate(gateOptions(client))
    const header = await signedHeader(gate.requirements)
    const result = await gate(new Request('http://x/premium', { headers: { 'X-PAYMENT': header } }))
    expect(result.paid).toBe(false)
    if (result.paid) throw new Error('unreachable')
    expect(result.response.status).toBe(502)
    expect(calls.settle).toHaveLength(0)
  })

  test('settle success for a DIFFERENT payer → UNKNOWN and does NOT unlock content', async () => {
    const { client } = fakeClient({
      settle: {
        success: true,
        transaction: `0x${'ab'.repeat(32)}`,
        payer: '0x9999999999999999999999999999999999999999',
        network: NETWORK,
        amount: '5000000',
      },
    })
    const gate = await createPermit2ExactX402Gate(gateOptions(client))
    const header = await signedHeader(gate.requirements)
    const result = await gate(new Request('http://x/premium', { headers: { 'X-PAYMENT': header } }))
    expect(result.paid).toBe(false)
    if (result.paid) throw new Error('unreachable')
    expect(result.response.status).toBe(502)
    expect(result.settlement?.status).toBe('unknown')
  })

  test('settle failure → 402 carrying the errorReason', async () => {
    const { client } = fakeClient({
      settle: {
        success: false,
        transaction: '',
        payer: '',
        network: NETWORK,
        errorReason: 'payee_not_registered',
      },
    })
    const gate = await createPermit2ExactX402Gate(gateOptions(client))
    const header = await signedHeader(gate.requirements)
    const result = await gate(new Request('http://x/premium', { headers: { 'X-PAYMENT': header } }))
    expect(result.paid).toBe(false)
    if (result.paid) throw new Error('unreachable')
    expect(result.response.status).toBe(402)
    expect(((await result.response.json()) as PaymentRequiredBody).error).toMatch(
      /payee_not_registered/,
    )
  })

  test('settle success without a complete proof → 502 and does NOT unlock content', async () => {
    for (const settle of [
      {
        success: true,
        transaction: '',
        payer: '0xpayer',
        network: NETWORK,
        amount: '5000000',
      },
      {
        success: true,
        transaction: `0x${'ab'.repeat(32)}`,
        payer: '0xpayer',
        network: NETWORK,
      },
      {
        success: true,
        transaction: `0x${'ab'.repeat(32)}`,
        payer: '0xpayer',
        network: NETWORK,
        amount: '1',
      },
      {
        success: true,
        transaction: `0x${'ab'.repeat(32)}`,
        payer: '0xpayer',
        network: 'eip155:56',
        amount: '5000000',
      },
    ] satisfies SettleResult[]) {
      const { client } = fakeClient({ settle })
      const gate = await createPermit2ExactX402Gate(gateOptions(client))
      const header = await signedHeader(gate.requirements)
      const result = await gate(
        new Request('http://x/premium', { headers: { 'X-PAYMENT': header } }),
      )
      expect(result.paid).toBe(false)
      if (result.paid) throw new Error('unreachable')
      expect(result.response.status).toBe(502)
      expect(((await result.response.json()) as { error: string }).error).toMatch(
        /settlement state UNKNOWN/,
      )
    }
  })

  test('SECURITY: buyer-supplied extensions/resource are STRIPPED from the forwarded payload', async () => {
    // The merchant RSA-signs the exact body it sends — forwarding buyer bytes
    // verbatim would let a paying attacker plant extensions.bazaar in b402's
    // discovery index as merchant-attested metadata.
    const { client, calls } = fakeClient({})
    const gate = await createPermit2ExactX402Gate(gateOptions(client))
    const account = privateKeyToAccount(generatePrivateKey())
    const payment = await buildPermit2ExactPayment({
      account,
      requirements: gate.requirements,
      trustedSpenders: [SPENDER],
    })
    const hostile = {
      ...payment,
      resource: { url: 'https://evil.example/phish' },
      extensions: { bazaar: { info: {}, schema: {}, description: 'attacker blob' } },
    }
    const result = await gate(
      new Request('http://x/premium', { headers: { 'X-PAYMENT': encodeXPayment(hostile) } }),
    )
    expect(result.paid).toBe(true)
    for (const call of [...calls.verify, ...calls.settle]) {
      expect('extensions' in call.paymentPayload).toBe(false)
      expect('resource' in call.paymentPayload).toBe(false)
    }
  })

  test("options.bazaar rides /settle (and ONLY /settle) as the MERCHANT's extensions", async () => {
    const { client, calls } = fakeClient({})
    const bazaar = { info: { input: {} }, schema: { type: 'object' }, description: 'mine' }
    const gate = await createPermit2ExactX402Gate({ ...gateOptions(client), bazaar })
    const header = await signedHeader(gate.requirements)
    const result = await gate(new Request('http://x/premium', { headers: { 'X-PAYMENT': header } }))
    expect(result.paid).toBe(true)
    expect('extensions' in (calls.verify[0]?.paymentPayload ?? {})).toBe(false)
    expect(calls.settle[0]?.paymentPayload.extensions).toEqual({ bazaar })
  })

  test('verify transport failure → 502, nothing settled, no throw', async () => {
    const { client, calls } = fakeClient({})
    const throwing: X402GateClient = {
      ...client,
      verify: () => Promise.reject(new Error('ECONNRESET')),
    }
    const gate = await createPermit2ExactX402Gate({ ...gateOptions(client), client: throwing })
    const header = await signedHeader(gate.requirements)
    const result = await gate(new Request('http://x/premium', { headers: { 'X-PAYMENT': header } }))
    expect(result.paid).toBe(false)
    if (result.paid) throw new Error('unreachable')
    expect(result.response.status).toBe(502)
    expect(((await result.response.json()) as { error: string }).error).toMatch(
      /nothing was settled/,
    )
    expect(calls.settle).toHaveLength(0)
  })

  test('settle transport failure → 502 flagging settlement state UNKNOWN (no bare throw)', async () => {
    const { client } = fakeClient({})
    const throwing: X402GateClient = {
      ...client,
      settle: () => Promise.reject(new Error('fetch timeout')),
    }
    const gate = await createPermit2ExactX402Gate({ ...gateOptions(client), client: throwing })
    const header = await signedHeader(gate.requirements)
    const result = await gate(new Request('http://x/premium', { headers: { 'X-PAYMENT': header } }))
    expect(result.paid).toBe(false)
    if (result.paid) throw new Error('unreachable')
    expect(result.response.status).toBe(502)
    expect(((await result.response.json()) as { error: string }).error).toMatch(
      /settlement state UNKNOWN/,
    )
    expect(result.settlement).toMatchObject({
      status: 'unknown',
      phase: 'settle',
      requirements: gate.requirements,
    })
  })

  test('settle UNKNOWN invokes the optional reconciliation hook with the exact signed request', async () => {
    const { client } = fakeClient({})
    const throwing: X402GateClient = {
      ...client,
      settle: () => Promise.reject(new Error('fetch timeout')),
    }
    const unknown: unknown[] = []
    const gate = await createPermit2ExactX402Gate({
      ...gateOptions(client),
      client: throwing,
      onSettlementUnknown: (context) => {
        unknown.push(context)
      },
    })
    const header = await signedHeader(gate.requirements)
    const result = await gate(new Request('http://x/premium', { headers: { 'X-PAYMENT': header } }))
    expect(result.paid).toBe(false)
    expect(unknown).toHaveLength(1)
    expect(unknown[0]).toMatchObject({
      status: 'unknown',
      phase: 'settle',
      requirements: gate.requirements,
      request: { paymentRequirements: gate.requirements },
    })
  })

  test('happy path → paid:true; withPaymentResponse attaches a decodable X-PAYMENT-RESPONSE', async () => {
    const { client, calls } = fakeClient({})
    const gate = await createPermit2ExactX402Gate(gateOptions(client))
    const header = await signedHeader(gate.requirements)
    const result = await gate(new Request('http://x/premium', { headers: { 'X-PAYMENT': header } }))
    expect(result.paid).toBe(true)
    if (!result.paid) throw new Error('unreachable')
    expect(result.settlement.transaction).toBe(`0x${'ab'.repeat(32)}`)
    // verify + settle both received OUR requirements, not buyer-echoed ones.
    expect(calls.verify[0]?.paymentRequirements).toEqual(gate.requirements)
    expect(calls.settle[0]?.paymentRequirements).toEqual(gate.requirements)
    expect(calls.verify[0]?.paymentPayload.accepted).toEqual(gate.requirements)
    expect(calls.settle[0]?.paymentPayload.accepted).toEqual(gate.requirements)

    const content = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
    const final = result.withPaymentResponse(content)
    expect(final.status).toBe(200)
    const settled = decodeXPaymentResponse(final.headers.get('X-PAYMENT-RESPONSE'))
    expect(settled?.success).toBe(true)
    expect(settled?.transaction).toBe(result.settlement.transaction)
    expect((await final.json()) as { ok: boolean }).toEqual({ ok: true })
  })
})

describe('createDynamicPermit2ExactX402Gate', () => {
  test('resolves per-request amounts while sharing one /supported cache', async () => {
    const { client, calls } = fakeClient({})
    const gate = createDynamicPermit2ExactX402Gate({
      client,
      resolvePayment: async (request) => ({
        network: NETWORK,
        asset: { address: ASSET, name: 'USDT Token' },
        payTo: PAY_TO,
        amount: new URL(request.url).searchParams.get('amount') ?? '5000000',
      }),
    })

    const url = 'http://x/premium?amount=5000000'
    const probe = await gate(new Request(url))
    expect(probe.paid).toBe(false)
    if (probe.paid) throw new Error('unreachable')
    const requirements = ((await probe.response.json()) as PaymentRequiredBody).accepts[0]!
    expect(requirements.amount).toBe('5000000')

    const paid = await gate(
      new Request(url, { headers: { 'X-PAYMENT': await signedHeader(requirements) } }),
    )
    expect(paid.paid).toBe(true)
    expect(calls.supported).toBe(1)
  })

  test('pins a paid retry to requirements resolved for that request', async () => {
    const { client, calls } = fakeClient({})
    const gate = createDynamicPermit2ExactX402Gate({
      client,
      resolvePayment: async (request) => ({
        network: NETWORK,
        asset: { address: ASSET, name: 'USDT Token' },
        payTo: PAY_TO,
        amount: new URL(request.url).searchParams.get('amount') ?? '5000000',
      }),
    })

    const probe = await gate(new Request('http://x/premium?amount=5000000'))
    if (probe.paid) throw new Error('unreachable')
    const requirements = ((await probe.response.json()) as PaymentRequiredBody).accepts[0]!
    const result = await gate(
      new Request('http://x/premium?amount=6000000', {
        headers: { 'X-PAYMENT': await signedHeader(requirements) },
      }),
    )
    expect(result.paid).toBe(false)
    if (result.paid) throw new Error('unreachable')
    expect(result.response.status).toBe(400)
    expect(calls.verify).toHaveLength(0)
    expect(calls.settle).toHaveLength(0)
  })
})
