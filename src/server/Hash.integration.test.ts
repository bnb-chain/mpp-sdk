/**
 * Hash credential — real mppx integration (spec §14.5.1.2).
 *
 * Goal: exercise the full `Mppx.create(...) → verifyCredential(...)` pipeline
 * with a real `charge(...)` server, the live `verifyHash`, and a stubbed
 * `publicClient` (so the test stays offline + deterministic).
 *
 * Asserts:
 *   - The handler accepts the credential (HMAC + Expires + verifyHash + the
 *     stub Transfer log all line up)
 *   - The returned Receipt contains every draft §7.6 Table 13 REQUIRED field,
 *     including `challengeId` and `chainId` (the two mppx Receipt.Schema
 *     does not model — this is the C2 invariant)
 *
 * `verifyCredential` returns the Receipt directly (not a Response); the
 * `Payment-Receipt` header round-trip is exercised separately in
 * Transport.test.ts via the dedicated `evmHttpTransport().respondReceipt`
 * fail-closed tests. Together those two test surfaces cover the full path
 * spec §14.5.1.2 mandates: verifier success → buildEvmReceipt → wire bytes
 * preserved on header decode.
 */

import { Credential } from 'mppx'
import { Mppx } from 'mppx/server'
import { type PublicClient, encodeAbiParameters, encodeEventTopics } from 'viem'
import { describe, expect, test } from 'vitest'

import { preflightChargeForTest } from '../../test/helpers/server/preflightChargeForTest.js'
import { charge } from './Charge.js'

const SECRET = 'integration-test-secret' as const
const RECIPIENT = '0x2222222222222222222222222222222222222222' as const
const PAYER = '0x4444444444444444444444444444444444444444' as const
const TX = `0x${'cd'.repeat(32)}` as const
const USDC_ETHEREUM = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const
// PERMIT2 fixture no longer needed at the route layer —
// server defaults inject methodDetails.permit2Address.
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

function happyStubPublicClient(): PublicClient {
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
            address: USDC_ETHEREUM,
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
        to: USDC_ETHEREUM,
        transactionHash: TX,
        transactionIndex: 0,
        type: 'eip1559' as const,
      }
    },
    async getBlockNumber() {
      // ethereum default confirmations is 12 → need ≥ 111 to satisfy.
      return 200n
    },
  } as unknown as PublicClient
}

describe('§14.5.1.2 — hash credential real mppx pipeline', () => {
  test('verifyCredential through real mppx returns receipt with draft §7.6 fields', async () => {
    const prepared = await preflightChargeForTest(
      {
        chain: 'ethereum',
        token: 'USDC',
        recipient: RECIPIENT,
        credentialTypes: ['hash'],
        challengeBinding: { mode: 'mppx-managed' }, // mppx HMAC + Expires
      },
      {
        mockedIsContractDeployed: () => true,
        publicClient: happyStubPublicClient(),
      },
    )
    const server = charge(prepared)
    const handler = Mppx.create({
      methods: [server],
      secretKey: SECRET,
    })

    // Factory return type preserves `ChargeServerDefaults`
    // as the 2nd generic, so handler.challenge.evm.charge accepts just the
    // per-call fields and defaults inject the rest. Partial methodDetails
    // at the route level is also forbidden — minimal-route is the
    // only correct shape now.
    const fullRequestArgs = {
      amount: AMOUNT,
      externalId: 'order-int-1',
    }

    // Issue a real challenge through mppx so the HMAC id is HMAC(SECRET).
    const challenge = await handler.challenge.evm.charge(fullRequestArgs)

    // Build the hash credential bound to that challenge.
    const credential = Credential.from({
      challenge,
      payload: { type: 'hash', hash: TX },
    })
    const serialized = Credential.serialize(credential)

    // Run the full mppx pipeline: deserialize → HMAC check → Expires.assert
    // → method schema validation → verifyHash. Returns the Receipt directly
    // (Receipt → header bytes is exercised in Transport.test.ts).
    const receipt = await handler.verifyCredential(serialized, {
      request: fullRequestArgs,
    })

    expect(receipt).toMatchObject({
      method: 'evm',
      status: 'success',
      reference: TX,
      challengeId: challenge.id,
      chainId: 1,
      externalId: 'order-int-1',
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/),
    })
  })
})
