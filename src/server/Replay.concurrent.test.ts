/**
 * Concurrent double-spend test (spec §14.7).
 *
 * The replay store's reserve / markConsumed / markRejected primitives are
 * the SDK's atomicity guard for credential-uniqueness. Replay.test.ts
 * covers the sequential semantics; this file covers the CONCURRENT
 * semantics that production sees under real load.
 *
 * Coverage:
 *   1. N parallel `reserve(key)` for the SAME key → exactly 1 returns true,
 *      N-1 return false. (Spec §9.3 — no double-mark.)
 *   2. N parallel `reserve` for DIFFERENT keys → all N return true.
 *   3. Race between two concurrent verifyHash() on the same txHash:
 *      first wins + receipt; second sees `consumed` and throws REPLAY.
 *
 * `Store.memory()` uses an in-process Map under the hood; the CAS
 * primitives `store.update(key, fn)` ARE atomic per-key by mppx contract
 * (the fn runs once and the resulting op is applied without interleaving
 * with a parallel fn for the same key). Production durable backends
 * (Redis WATCH/MULTI, Postgres SELECT FOR UPDATE, Cloudflare KV
 * transactions) MUST guarantee the same primitive.
 */

import { Errors, Store } from 'mppx'
import {
  type Log,
  type PublicClient,
  type TransactionReceipt,
  encodeAbiParameters,
  encodeEventTopics,
} from 'viem'
import { describe, expect, test } from 'vitest'

import { verifyHash } from './Hash.js'
import { type ChargeStore, hashKey, reserve } from './Replay.js'

const CHAIN_ID = 1
const TX = `0x${'ab'.repeat(32)}` as const
const CURRENCY = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const
const RECIPIENT = '0x2222222222222222222222222222222222222222' as const
const PAYER = '0x3333333333333333333333333333333333333333' as const
const AMOUNT = '1000000'

function freshStore(): ChargeStore {
  return Store.memory() as unknown as ChargeStore
}

/* -------------------------------------------------------------------------- */
/*  Primitive-level concurrency                                               */
/* -------------------------------------------------------------------------- */

describe('Replay primitives — concurrent reserve atomicity', () => {
  test('N parallel reserves on the SAME key → exactly 1 wins', async () => {
    const store = freshStore()
    const key = hashKey(CHAIN_ID, TX)
    const N = 50

    const results = await Promise.all(Array.from({ length: N }, () => reserve(store, key)))
    const winners = results.filter((r) => r === true)
    const losers = results.filter((r) => r === false)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(N - 1)
  })

  test('N parallel reserves on DIFFERENT keys → all win', async () => {
    const store = freshStore()
    const N = 20
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => {
        const tx = `0x${i.toString(16).padStart(64, '0')}` as `0x${string}`
        return reserve(store, hashKey(CHAIN_ID, tx))
      }),
    )
    expect(results.every((r) => r === true)).toBe(true)
  })

  test('reserve → reserve on same key returns false (sequential sanity)', async () => {
    const store = freshStore()
    const key = hashKey(CHAIN_ID, TX)
    expect(await reserve(store, key)).toBe(true)
    expect(await reserve(store, key)).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/*  End-to-end concurrency via verifyHash                                     */
/* -------------------------------------------------------------------------- */

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

function happyReceipt(): TransactionReceipt {
  const transferLog: Log = {
    address: CURRENCY,
    blockHash: `0x${'a'.repeat(64)}` as `0x${string}`,
    blockNumber: 100n,
    data: encodeAbiParameters([{ type: 'uint256' }], [BigInt(AMOUNT)]),
    logIndex: 0,
    removed: false,
    topics: encodeEventTopics({
      abi: TRANSFER_ABI,
      eventName: 'Transfer',
      args: { from: PAYER, to: RECIPIENT },
    }) as Log['topics'],
    transactionHash: TX,
    transactionIndex: 0,
  } as Log
  return {
    blockHash: `0x${'b'.repeat(64)}`,
    blockNumber: 100n,
    contractAddress: null,
    cumulativeGasUsed: 0n,
    effectiveGasPrice: 0n,
    from: PAYER,
    gasUsed: 0n,
    logs: [transferLog],
    logsBloom: '0x',
    status: 'success' as const,
    to: CURRENCY,
    transactionHash: TX,
    transactionIndex: 0,
    type: 'eip1559' as const,
  } as unknown as TransactionReceipt
}

function stubPublicClient(): PublicClient {
  return {
    async getTransactionReceipt() {
      return happyReceipt()
    },
    async getBlockNumber() {
      return 100n
    },
  } as unknown as PublicClient
}

function buildCredential() {
  return {
    challenge: {
      id: 'chal_concurrent',
      realm: 'https://test.example/',
      method: 'evm',
      intent: 'charge',
      request: { amount: AMOUNT, currency: CURRENCY, recipient: RECIPIENT },
      expires: new Date(Date.now() + 60_000).toISOString(),
    },
    payload: { type: 'hash', hash: TX },
  } as Parameters<typeof verifyHash>[0]['credential']
}

describe('verifyHash — concurrent double-spend rejection', () => {
  test('N parallel verifyHash on same (txHash) → 1 success + N-1 REPLAY/CONCURRENT', async () => {
    const store = freshStore()
    const ctx: Parameters<typeof verifyHash>[0]['ctx'] = {
      publicClient: stubPublicClient(),
      store,
      chainId: CHAIN_ID,
      confirmations: 0,
      hashFromPolicy: 'lax_from' as const,
    }
    const request = { amount: AMOUNT, currency: CURRENCY, recipient: RECIPIENT }

    const N = 10
    const settled = await Promise.allSettled(
      Array.from({ length: N }, () => verifyHash({ credential: buildCredential(), request, ctx })),
    )

    const fulfilled = settled.filter((r) => r.status === 'fulfilled')
    const rejected = settled.filter((r) => r.status === 'rejected')

    // Exactly 1 success.
    expect(fulfilled).toHaveLength(1)
    // The rest are all VerificationFailedError (REPLAY / CONCURRENT).
    expect(rejected).toHaveLength(N - 1)
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(Errors.VerificationFailedError)
    }

    // Final state: slot is consumed.
    const final = await store.get(hashKey(CHAIN_ID, TX))
    expect(final?.state).toBe('consumed')
  })
})
