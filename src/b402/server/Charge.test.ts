import { Challenge, Credential, Receipt } from 'mppx'
import { Mppx as ClientMppx } from 'mppx/client'
import { Mppx } from 'mppx/server'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vitest'

import type { FacilitatorRequest } from '../Client.js'
import { charge as clientCharge } from '../client/Charge.js'
import {
  chargeMethod,
  type B402ChargeCredentialPayload,
  type B402ChargeRequest,
  type B402ChargeTransferMethod,
} from '../Methods.js'
import { CURATED_B402_SPENDERS } from '../Permit2.js'
import type { SupportedResponse } from '../Types.js'
import { charge } from './Charge.js'
import { B402SettlementUnknownError } from './Settlement.js'
import type { B402FacilitatorClient } from './Types.js'

const NETWORK = 'eip155:97' as const
const CURRENCY = '0x337610d27c682E347C9cD60BD4b3b107C9d34dDd' as const
const RECIPIENT = '0x2222222222222222222222222222222222222222' as const
const SIGNER = '0x1111111111111111111111111111111111111111' as const
const SPENDER = CURATED_B402_SPENDERS[NETWORK]!.exact
const TX_HASH = `0x${'ab'.repeat(32)}`

type B402Challenge = Challenge.Challenge<B402ChargeRequest, 'charge', 'b402'>
type B402Credential = Credential.Credential<B402ChargeCredentialPayload, B402Challenge>

const SUPPORTED: SupportedResponse = {
  extensions: [],
  kinds: [
    {
      extra: {
        assetTransferMethod: 'eip3009',
        name: 'USDT Token',
        signerAddress: SIGNER,
        version: '1',
      },
      network: NETWORK,
      scheme: 'exact',
      x402Version: 2,
    },
    {
      extra: {
        assetTransferMethod: 'permit2-exact',
        name: 'USDT Token',
        signerAddress: SIGNER,
        spenderAddress: SPENDER,
        version: '1',
      },
      network: NETWORK,
      scheme: 'exact',
      x402Version: 2,
    },
  ],
  signers: { [NETWORK]: [SIGNER] },
}

function payerOf(request: FacilitatorRequest): string {
  const payload = request.paymentPayload.payload
  return 'authorization' in payload ? payload.authorization.from : payload.permit2Authorization.from
}

function fakeClient(): {
  client: B402FacilitatorClient
  settle: FacilitatorRequest[]
  supported: { calls: number }
  verify: FacilitatorRequest[]
} {
  const state = { calls: 0 }
  const verify: FacilitatorRequest[] = []
  const settle: FacilitatorRequest[] = []
  return {
    client: {
      settle: async (request) => {
        settle.push(request)
        return {
          amount: request.paymentRequirements.amount,
          network: request.paymentRequirements.network,
          payer: payerOf(request),
          success: true,
          transaction: TX_HASH,
        }
      },
      supported: async () => {
        state.calls += 1
        return SUPPORTED
      },
      verify: async (request) => {
        verify.push(request)
        return { isValid: true, payer: payerOf(request) }
      },
    },
    settle,
    supported: state,
    verify,
  }
}

async function credentialFor(parameters: {
  client: B402FacilitatorClient
  transferMethod: B402ChargeTransferMethod
}) {
  const server = await charge({
    bazaar: { info: { route: 'report' }, schema: { type: 'object' } },
    client: parameters.client,
    currency: { address: CURRENCY, decimals: 6, name: 'USDT Token', version: '1' },
    network: NETWORK,
    recipient: RECIPIENT,
  })
  const routeRequest = {
    ...server.defaults!,
    amount: '5',
    transferMethod: parameters.transferMethod,
  }
  const resolved = await server.request!({ credential: null, request: routeRequest })
  const challenge = Challenge.fromMethod(chargeMethod, {
    expires: new Date(Date.now() + 5 * 60_000).toISOString(),
    realm: 'merchant.example',
    request: resolved,
    secretKey: 'test-secret-key-that-is-at-least-32-bytes',
  }) as B402Challenge
  const account = privateKeyToAccount(generatePrivateKey())
  const client = clientCharge({
    account,
    permit2Allowance: () => Promise.resolve(10_000_000n),
    trustedSpenders: { [NETWORK]: [SPENDER] },
  })
  const credential = Credential.deserialize<B402ChargeCredentialPayload>(
    await client.createCredential({ challenge }),
  ) as B402Credential
  return { credential, routeRequest, server }
}

describe('b402 server charge', () => {
  test('creates a runnable HTTP handler after asynchronous capability initialization', async () => {
    const fake = fakeClient()
    const method = await charge({
      client: fake.client,
      currency: { address: CURRENCY, decimals: 6, name: 'USDT Token', version: '1' },
      network: NETWORK,
      recipient: RECIPIENT,
    })
    const server = Mppx.create({
      methods: [method],
      realm: 'merchant.example',
      secretKey: 'test-secret-key-that-is-at-least-32-bytes',
    })

    const handler = server.b402.charge({ amount: '5', transferMethod: 'permit2-exact' })
    const buyer = ClientMppx.create({
      fetch: async (input, init) => {
        const result = await handler(new Request(input, init))
        if (result.status === 402) return result.challenge
        return result.withReceipt(new Response('paid'))
      },
      methods: [
        clientCharge({
          account: privateKeyToAccount(generatePrivateKey()),
          permit2Allowance: () => Promise.resolve(10_000_000n),
          trustedSpenders: { [NETWORK]: [SPENDER] },
        }),
      ],
      polyfill: false,
    })
    const paid = await buyer.fetch('https://merchant.example/resource')

    expect(paid.status).toBe(200)
    expect(Receipt.fromResponse(paid)).toMatchObject({
      method: 'b402',
      status: 'success',
      transferMethod: 'permit2-exact',
    })
    expect(fake.supported.calls).toBe(1)
  })

  test.each(['eip3009', 'permit2-exact'] as const)(
    'runs %s through the real mppx challenge and verification pipeline',
    async (transferMethod) => {
      const fake = fakeClient()
      const method = await charge({
        client: fake.client,
        currency: { address: CURRENCY, decimals: 6, name: 'USDT Token', version: '1' },
        network: NETWORK,
        recipient: RECIPIENT,
      })
      const server = Mppx.create({
        methods: [method],
        realm: 'merchant.example',
        secretKey: 'test-secret-key-that-is-at-least-32-bytes',
      })
      const challenge = await server.challenge.b402.charge({ amount: '5', transferMethod })
      const account = privateKeyToAccount(generatePrivateKey())
      const client = clientCharge({
        account,
        permit2Allowance: () => Promise.resolve(10_000_000n),
        trustedSpenders: { [NETWORK]: [SPENDER] },
      })
      const credential = await client.createCredential({ challenge: challenge as B402Challenge })

      const receipt = await server.verifyCredential(credential, {
        request: { amount: '5', transferMethod },
      })
      expect(receipt).toMatchObject({
        challengeId: (challenge as B402Challenge).id,
        method: 'b402',
        network: NETWORK,
        reference: TX_HASH,
        status: 'success',
        transferMethod,
      })
      expect(fake.supported.calls).toBe(1)
    },
  )

  test.each(['eip3009', 'permit2-exact'] as const)(
    'verifies and settles the %s MPP credential through B402',
    async (transferMethod) => {
      const fake = fakeClient()
      const fixture = await credentialFor({ client: fake.client, transferMethod })

      const receipt = await fixture.server.verify({
        credential: fixture.credential,
        request: fixture.routeRequest,
      })

      expect(receipt).toMatchObject({ method: 'b402', reference: TX_HASH, status: 'success' })
      expect(fake.verify).toHaveLength(1)
      expect(fake.settle).toHaveLength(1)
      expect(fake.verify[0]!.paymentPayload).not.toHaveProperty('extensions')
      expect(fake.settle[0]!.paymentPayload.extensions).toEqual({
        bazaar: { info: { route: 'report' }, schema: { type: 'object' } },
      })

      const retry = await fixture.server.request!({
        credential: fixture.credential,
        request: fixture.routeRequest,
      })
      expect(retry.providerSnapshot).toBeDefined()
      expect(fake.supported.calls).toBe(1)
    },
  )

  test.each(['eip3009', 'permit2-exact'] as const)(
    'rejects %s economic-field drift before calling the provider',
    async (transferMethod) => {
      const fake = fakeClient()
      const fixture = await credentialFor({ client: fake.client, transferMethod })
      if (fixture.credential.payload.type === 'eip3009') {
        ;(fixture.credential.payload.authorization as { value: string }).value = '1'
      } else {
        ;(fixture.credential.payload.permit2Authorization.permitted as { amount: string }).amount =
          '1'
      }

      await expect(
        fixture.server.verify({
          credential: fixture.credential,
          request: fixture.routeRequest,
        }),
      ).rejects.toThrow(/malformed/)
      expect(fake.verify).toHaveLength(0)
      expect(fake.settle).toHaveLength(0)
    },
  )

  test.each(['eip3009', 'permit2-exact'] as const)(
    'rejects an over-long %s authorization before calling the provider',
    async (transferMethod) => {
      const fake = fakeClient()
      const fixture = await credentialFor({ client: fake.client, transferMethod })
      const overlong = String(Math.floor(Date.now() / 1000) + 3600)
      if (fixture.credential.payload.type === 'eip3009') {
        ;(fixture.credential.payload.authorization as { validBefore: string }).validBefore =
          overlong
      } else {
        ;(fixture.credential.payload.permit2Authorization as { deadline: string }).deadline =
          overlong
      }

      await expect(
        fixture.server.verify({
          credential: fixture.credential,
          request: fixture.routeRequest,
        }),
      ).rejects.toThrow(/settlement window/)
      expect(fake.verify).toHaveLength(0)
      expect(fake.settle).toHaveLength(0)
    },
  )

  test('emits a typed unknown instead of treating malformed success as unpaid', async () => {
    const fake = fakeClient()
    fake.client.settle = async (request) => ({
      amount: request.paymentRequirements.amount,
      network: request.paymentRequirements.network,
      payer: payerOf(request),
      success: true,
      transaction: '',
    })
    const unknown: unknown[] = []
    const fixture = await credentialFor({ client: fake.client, transferMethod: 'eip3009' })
    const server = await charge({
      client: fake.client,
      currency: { address: CURRENCY, decimals: 6, name: 'USDT Token', version: '1' },
      network: NETWORK,
      onSettlementUnknown: (event) => {
        unknown.push(event)
      },
      recipient: RECIPIENT,
    })

    await expect(
      server.verify({ credential: fixture.credential, request: fixture.routeRequest }),
    ).rejects.toBeInstanceOf(B402SettlementUnknownError)
    expect(unknown).toHaveLength(1)
    expect(unknown[0]).toMatchObject({ phase: 'settle', status: 'unknown' })
  })
})
