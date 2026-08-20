import { buildEip3009Payment, type SupportedResponse } from '@bnb-chain/b402'
import {
  B402SettlementUnknownError,
  type B402Transport,
  type FacilitatorRequest,
} from '@bnb-chain/b402/server'
import { Receipt, Store, x402 } from 'mppx'
import { Mppx as ClientMppx, evm as evmClient } from 'mppx/client'
import { Mppx as ServerMppx, evm as evmServer } from 'mppx/server'
import { getAddress, type LocalAccount } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vitest'

import { createB402Facilitator } from './Facilitator.js'

const NETWORK = 'eip155:97' as const
const CURRENCY = '0x337610d27c682E347C9cD60BD4b3b107C9d34dDd'
const RECIPIENT = '0x2222222222222222222222222222222222222222'
const SIGNER = '0x1111111111111111111111111111111111111111'
const TX_HASH = `0x${'ab'.repeat(32)}`
const NONCE = `0x${'12'.repeat(32)}` as const

/** The payer signs for real — the adapter recovers and compares locally. */
const PAYER_ACCOUNT = privateKeyToAccount(generatePrivateKey())
const PAYER = PAYER_ACCOUNT.address

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
  ],
  signers: { [NETWORK]: [SIGNER] },
}

/**
 * A GENUINELY signed EIP-3009 payment in x402 shape. The signature must be
 * real: the adapter recovers the payer locally and compares it against the
 * declared `from` before touching a replay slot (audit H02 follow-up), so a
 * fabricated signature no longer reaches settlement.
 */
async function payment(account: LocalAccount = PAYER_ACCOUNT): Promise<{
  payload: x402.Types.PaymentPayload
  requirements: x402.Types.PaymentRequirements
}> {
  const requirements: x402.Types.PaymentRequirements = {
    amount: '5000000',
    asset: CURRENCY,
    extra: { assetTransferMethod: 'eip3009', name: 'USDT Token', version: '1' },
    maxTimeoutSeconds: 300,
    network: NETWORK,
    payTo: RECIPIENT,
    scheme: 'exact',
  }
  // Sign against the SAME domain the adapter rebuilds from /supported
  // (token name + version, chainId, token address).
  const signed = await buildEip3009Payment({
    account,
    nonce: NONCE,
    requirements: {
      amount: '5000000',
      asset: getAddress(CURRENCY),
      extra: {
        assetTransferMethod: 'eip3009',
        name: 'USDT Token',
        signerAddress: getAddress(SIGNER),
        version: '1',
      },
      maxTimeoutSeconds: 300,
      network: NETWORK,
      payTo: getAddress(RECIPIENT),
      scheme: 'exact',
    },
  })
  return {
    payload: {
      accepted: requirements,
      payload: signed.payload,
      x402Version: 2,
    },
    requirements,
  }
}

function fakeClient(): {
  client: B402Transport
  settle: FacilitatorRequest[]
  verify: FacilitatorRequest[]
} {
  const verify: FacilitatorRequest[] = []
  const settle: FacilitatorRequest[] = []
  return {
    client: {
      settle: async (request) => {
        settle.push(request)
        return {
          amount: request.paymentRequirements.amount,
          network: request.paymentRequirements.network,
          payer: payerFrom(request),
          success: true,
          transaction: TX_HASH,
        }
      },
      supported: () => Promise.resolve(SUPPORTED),
      verify: async (request) => {
        verify.push(request)
        return { isValid: true, payer: payerFrom(request) }
      },
    },
    settle,
    verify,
  }
}

function payerFrom(request: FacilitatorRequest): string {
  const payload = request.paymentPayload.payload
  return 'authorization' in payload ? payload.authorization.from : payload.permit2Authorization.from
}

describe('createB402Facilitator', () => {
  test('runs through the real standard mppx EVM Charge client/server lifecycle', async () => {
    const fake = fakeClient()
    const server = ServerMppx.create({
      methods: [
        evmServer.charge({
          authorization: { name: 'USDT Token', version: '1' },
          chainId: 97,
          currency: CURRENCY,
          decimals: 6,
          recipient: RECIPIENT,
          x402: { facilitator: createB402Facilitator({ client: fake.client }) },
        }),
      ],
      realm: 'merchant.example',
      secretKey: 'test-secret-key-that-is-at-least-32-bytes',
    })
    const client = ClientMppx.create({
      methods: [
        evmClient.charge({
          account: privateKeyToAccount(generatePrivateKey()),
          authorization: { name: 'USDT Token', version: '1' },
        }),
      ],
      polyfill: false,
    })
    const route = server.evm.charge({ amount: '5' })
    const first = await route(new Request('https://merchant.example/resource'))
    expect(first.status).toBe(402)
    if (first.status !== 402) throw new Error('expected challenge')

    const credential = await client.createCredential(first.challenge)
    const paid = await route(
      new Request('https://merchant.example/resource', {
        headers: { Authorization: credential },
      }),
    )

    expect(paid.status).toBe(200)
    if (paid.status !== 200) throw new Error('expected paid response')
    expect(Receipt.fromResponse(paid.withReceipt(new Response('paid')))).toMatchObject({
      method: 'evm',
      reference: TX_HASH,
      status: 'success',
    })
    expect(fake.verify).toHaveLength(1)
    expect(fake.settle).toHaveLength(1)
  })

  test('adapts standard mppx EIP-3009 requirements to the B402 signer snapshot', async () => {
    const fake = fakeClient()
    const facilitator = createB402Facilitator({ client: fake.client })
    const { payload, requirements } = await payment()

    expect(await facilitator.verify(payload, requirements)).toEqual({
      isValid: true,
      payer: PAYER,
    })
    expect(fake.verify[0]!.paymentRequirements.extra).toEqual(SUPPORTED.kinds[0]!.extra)

    expect(await facilitator.settle(payload, requirements)).toMatchObject({
      success: true,
      transaction: TX_HASH,
    })
    expect(fake.settle).toHaveLength(1)
  })

  test('rejects Permit2 because the standard mppx facilitator seam is EIP-3009-only', async () => {
    const fake = fakeClient()
    const facilitator = createB402Facilitator({ client: fake.client })
    const { payload, requirements } = await payment()
    const permit2Requirements = {
      ...requirements,
      extra: { ...requirements.extra, assetTransferMethod: 'permit2' },
    }

    await expect(facilitator.verify(payload, permit2Requirements)).rejects.toThrow(/eip3009/)
    expect(fake.verify).toHaveLength(0)
  })

  test('surfaces ambiguous settlement through the shared typed callback', async () => {
    const fake = fakeClient()
    fake.client.settle = async (request) => ({
      amount: request.paymentRequirements.amount,
      network: request.paymentRequirements.network,
      payer: PAYER,
      success: true,
      transaction: '',
    })
    const events: unknown[] = []
    const facilitator = createB402Facilitator({
      client: fake.client,
      onSettlementUnknown(event) {
        events.push(event)
      },
    })
    const { payload, requirements } = await payment()

    await expect(facilitator.settle(payload, requirements)).rejects.toBeInstanceOf(
      B402SettlementUnknownError,
    )
    expect(events).toHaveLength(1)
  })

  // ── Slot squatting (audit H02 follow-up) ─────────────────────────────────
  //
  // The replay guard keys on the payer address. This adapter previously took
  // that address from the payload's self-declared `authorization.from` with
  // NO local verification, so an attacker who copied a victim's
  // publicly-visible address + nonce onto a garbage-signed payload could claim
  // the victim's slot first and have the victim's genuine payment rejected as
  // "already in progress". Recovering the payer locally closes it: the forged
  // payload is refused before any slot is touched.
  test('a forged `from` is rejected locally and never claims the replay slot', async () => {
    const fake = fakeClient()
    const facilitator = createB402Facilitator({ client: fake.client, store: Store.memory() })

    const victim = await payment()
    // Attacker signs with their OWN key, then swaps in the victim's address.
    const forged = await payment(privateKeyToAccount(generatePrivateKey()))
    ;(forged.payload.payload as { authorization: { from: string } }).authorization.from = PAYER

    await expect(facilitator.settle(forged.payload, forged.requirements)).rejects.toThrow(
      /does not match authorization\.from/,
    )
    expect(fake.settle).toHaveLength(0) // never reached the facilitator

    // The victim's genuine payment still settles — its slot was never taken.
    expect(await facilitator.settle(victim.payload, victim.requirements)).toMatchObject({
      success: true,
      transaction: TX_HASH,
    })
    expect(fake.settle).toHaveLength(1)
  })

  test('a garbage signature is rejected before the facilitator is called', async () => {
    const fake = fakeClient()
    const facilitator = createB402Facilitator({ client: fake.client, store: Store.memory() })
    const { payload, requirements } = await payment()
    ;(payload.payload as { signature: string }).signature = `0x${'34'.repeat(65)}`

    await expect(facilitator.settle(payload, requirements)).rejects.toThrow()
    expect(fake.settle).toHaveLength(0)
  })
})
