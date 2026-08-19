/**
 * createHashCredential — unit + round-trip through server verifier.
 *
 * Unit: builds a hash credential, deserializes it, asserts wire payload.
 * Round-trip: issues a real challenge from a Mppx.create handler, builds
 * the credential via the client function, verifies it via
 * handler.verifyCredential (stubbed publicClient returns a happy receipt).
 */

import { Credential } from 'mppx'
import { Mppx } from 'mppx/server'
import { type PublicClient, encodeAbiParameters, encodeEventTopics } from 'viem'
import { describe, expect, test } from 'vitest'

import { preflightChargeForTest } from '../../test/helpers/server/preflightChargeForTest.js'
import { charge } from '../server/Charge.js'
import { createHashCredential } from './Hash.js'

const SECRET = 'client-test-secret-at-least-32-bytes' as const
const CHAIN_ID = 1
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const
// PERMIT2 fixture no longer needed at the route layer —
// server defaults inject methodDetails.permit2Address.
const RECIPIENT = '0x2222222222222222222222222222222222222222' as const
const PAYER = '0x4444444444444444444444444444444444444444' as const
const TX = `0x${'ab'.repeat(32)}` as const
const AMOUNT = '1000000'

const TRANSFER_ABI = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const

function happyPublicClient(): PublicClient {
  return {
    async getTransactionReceipt() {
      return {
        blockHash: `0x${'a'.repeat(64)}`,
        blockNumber: 100n,
        contractAddress: null,
        cumulativeGasUsed: 0n,
        effectiveGasPrice: 0n,
        from: PAYER,
        gasUsed: 0n,
        logs: [
          {
            address: USDC,
            blockHash: `0x${'b'.repeat(64)}`,
            blockNumber: 100n,
            data: encodeAbiParameters([{ type: 'uint256' }], [BigInt(AMOUNT)]),
            logIndex: 0,
            removed: false,
            topics: encodeEventTopics({
              abi: TRANSFER_ABI,
              eventName: 'Transfer',
              args: { from: PAYER, to: RECIPIENT },
            }),
            transactionHash: TX,
            transactionIndex: 0,
          },
        ],
        logsBloom: '0x',
        status: 'success' as const,
        to: USDC,
        transactionHash: TX,
        transactionIndex: 0,
        type: 'eip1559' as const,
      }
    },
    async getBlockNumber() {
      return 200n
    },
  } as unknown as PublicClient
}

async function buildHandler() {
  const prepared = await preflightChargeForTest(
    {
      chain: 'ethereum',
      token: 'USDC',
      recipient: RECIPIENT,
      credentialTypes: ['hash'],
      challengeBinding: { mode: 'mppx-managed' },
    },
    { mockedIsContractDeployed: () => true, publicClient: happyPublicClient() },
  )
  return Mppx.create({ methods: [charge(prepared)], secretKey: SECRET })
}

// Route options should carry ONLY per-call fields. See the
// equivalent comment in Permit2.test.ts / Authorization.test.ts for why
// partial methodDetails at the route level is rejected by the
// request-hook guard.
const fullRequest = { amount: AMOUNT } as const

/* -------------------------------------------------------------------------- */
/*  Unit                                                                      */
/* -------------------------------------------------------------------------- */

describe('createHashCredential — unit', () => {
  test('output deserializes with type=hash + hash field', async () => {
    const handler = await buildHandler()
    const challenge = await handler.challenge.evm.charge(fullRequest)
    const serialized = await createHashCredential({ challenge, hash: TX })
    const parsed = Credential.deserialize(serialized)
    expect((parsed.payload as { type: string }).type).toBe('hash')
    expect((parsed.payload as { hash: string }).hash).toBe(TX)
  })

  test('source field is included when provided', async () => {
    const handler = await buildHandler()
    const challenge = await handler.challenge.evm.charge(fullRequest)
    const did = `did:pkh:eip155:${CHAIN_ID}:${PAYER}`
    const serialized = await createHashCredential({ challenge, hash: TX, source: did })
    const parsed = Credential.deserialize(serialized)
    expect(parsed.source).toBe(did)
  })

  test('source field is omitted when absent', async () => {
    const handler = await buildHandler()
    const challenge = await handler.challenge.evm.charge(fullRequest)
    const serialized = await createHashCredential({ challenge, hash: TX })
    const parsed = Credential.deserialize(serialized)
    expect(parsed.source).toBeUndefined()
  })
})

/* -------------------------------------------------------------------------- */
/*  Round-trip via server verifier                                            */
/* -------------------------------------------------------------------------- */

describe('createHashCredential — round-trip with server verifier', () => {
  test('handler.verifyCredential accepts client-built credential (source matches Transfer.from)', async () => {
    const handler = await buildHandler()
    const challenge = await handler.challenge.evm.charge(fullRequest)
    const serialized = await createHashCredential({
      challenge,
      hash: TX,
      source: `did:pkh:eip155:${CHAIN_ID}:${PAYER}`,
    })

    const receipt = await handler.verifyCredential(serialized, { request: fullRequest })
    expect(receipt).toMatchObject({
      method: 'evm',
      status: 'success',
      reference: TX,
      challengeId: challenge.id,
      chainId: CHAIN_ID,
    })
  })

  test('a source-less credential is rejected under the strict_from default (audit H01)', async () => {
    const handler = await buildHandler()
    const challenge = await handler.challenge.evm.charge(fullRequest)
    const serialized = await createHashCredential({ challenge, hash: TX })

    await expect(handler.verifyCredential(serialized, { request: fullRequest })).rejects.toThrow(
      /strict_from.*requires credential\.source/,
    )
  })
})
