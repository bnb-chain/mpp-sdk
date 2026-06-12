/**
 * Hash credential verifier unit tests (spec §8.4).
 *
 * Coverage matrix (spec §8.4 step → failure mode → replay state transition):
 *
 *   Step | Failure                       | Replay action
 *   ---- | ------------------------------ | -------------
 *   1    | already consumed              | terminal (no slot change)
 *   1    | already rejected              | terminal (no slot change)
 *   1    | concurrent inflight           | terminal (no slot change)
 *   2    | receipt not found             | release
 *   3    | insufficient confirmations    | release
 *   4    | tx reverted                   | markRejected
 *   5    | Transfer event mismatch       | markRejected (3 sub-cases:
 *                                          wrong currency / recipient / amount)
 *   6    | strict_from violation         | markRejected (3 sub-cases:
 *                                          missing source / bad format /
 *                                          address mismatch)
 *   7    | happy path                    | markConsumed → receipt
 *
 * Plus: lax_from default skips step 6 entirely; externalId is echoed in
 * the receipt when present on the request.
 */

import { Errors, Store } from 'mppx'
import {
  type Log,
  type PublicClient,
  type TransactionReceipt,
  encodeAbiParameters,
  encodeEventTopics,
  TransactionReceiptNotFoundError,
} from 'viem'
import { describe, expect, test, vi } from 'vitest'

import {
  failOnState,
  terminalFailureStore,
} from '../../test/helpers/server/terminalFailureStore.js'
import { type HashVerifierArgs, type HashVerifierCtx, verifyHash } from './Hash.js'
import { type ChargeStore, txHashKey } from './Replay.js'

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

const CHAIN_ID = 1
const CURRENCY = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const // USDC
const RECIPIENT = '0x2222222222222222222222222222222222222222' as const
const PAYER = '0x3333333333333333333333333333333333333333' as const
const AMOUNT = '1000000'
const TX_HASH = `0x${'ab'.repeat(32)}` as const

const CONFIRMATIONS = 0 // tests don't need depth gating unless explicitly testing step 3

const CHALLENGE_ID = 'chal_test_abc'

function freshStore(): ChargeStore {
  return Store.memory() as unknown as ChargeStore
}

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

function transferLog(args: {
  from: `0x${string}`
  to: `0x${string}`
  value: bigint
  address: `0x${string}`
  blockNumber?: bigint
}): Log {
  const { from, to, value, address, blockNumber = 100n } = args
  return {
    address,
    blockHash: `0x${'a'.repeat(64)}` as `0x${string}`,
    blockNumber,
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
    logIndex: 0,
    removed: false,
    topics: encodeEventTopics({
      abi: TRANSFER_ABI,
      eventName: 'Transfer',
      args: { from, to },
    }) as Log['topics'],
    transactionHash: TX_HASH,
    transactionIndex: 0,
  } as Log
}

function buildReceipt(args: {
  status?: 'success' | 'reverted'
  blockNumber?: bigint
  logs?: Log[]
}): TransactionReceipt {
  const { status = 'success', blockNumber = 100n, logs = [] } = args
  return {
    blockHash: `0x${'b'.repeat(64)}` as `0x${string}`,
    blockNumber,
    contractAddress: null,
    cumulativeGasUsed: 0n,
    effectiveGasPrice: 0n,
    from: PAYER,
    gasUsed: 0n,
    logs,
    logsBloom: '0x' as `0x${string}`,
    status,
    to: CURRENCY,
    transactionHash: TX_HASH,
    transactionIndex: 0,
    type: 'eip1559',
  } as TransactionReceipt
}

interface StubReceiptMap {
  /** Throw a TransactionReceiptNotFoundError-shaped error if true. */
  notFound?: boolean
  receipt?: TransactionReceipt
  rpcError?: Error
}

function stubPublicClient(args: { receipt: StubReceiptMap; latestBlock?: bigint }): PublicClient {
  const { receipt: rmap, latestBlock = 100n } = args
  return {
    async getTransactionReceipt() {
      // The REAL viem class — the verifier narrows on instanceof to
      // distinguish "not mined yet" from generic RPC failures.
      if (rmap.notFound) throw new TransactionReceiptNotFoundError({ hash: TX_HASH })
      if (rmap.rpcError) throw rmap.rpcError
      return rmap.receipt!
    },
    async getBlockNumber() {
      return latestBlock
    },
  } as unknown as PublicClient
}

function buildCredential(
  overrides: {
    source?: string
    hash?: `0x${string}`
  } = {},
): HashVerifierArgs['credential'] {
  return {
    challenge: {
      id: CHALLENGE_ID,
      realm: 'https://test.example/',
      method: 'evm',
      intent: 'charge',
      request: { amount: AMOUNT, currency: CURRENCY, recipient: RECIPIENT },
      expires: new Date(Date.now() + 60_000).toISOString(),
    },
    payload: { type: 'hash', hash: overrides.hash ?? TX_HASH },
    ...(overrides.source !== undefined && { source: overrides.source }),
  } as unknown as HashVerifierArgs['credential']
}

function buildRequest(
  overrides: Partial<HashVerifierArgs['request']> = {},
): HashVerifierArgs['request'] {
  return {
    amount: AMOUNT,
    currency: CURRENCY,
    recipient: RECIPIENT,
    ...overrides,
  }
}

function buildCtx(
  overrides: Partial<HashVerifierCtx> & { publicClient: PublicClient },
): HashVerifierCtx {
  return {
    store: freshStore(),
    chainId: CHAIN_ID,
    confirmations: CONFIRMATIONS,
    hashFromPolicy: 'lax_from',
    ...overrides,
  }
}

/* -------------------------------------------------------------------------- */
/*  Step 7: happy path                                                        */
/* -------------------------------------------------------------------------- */

describe('verifyHash happy path (lax_from default)', () => {
  test('returns receipt with all draft §7.6 fields + marks consumed', async () => {
    const receipt = buildReceipt({
      logs: [transferLog({ from: PAYER, to: RECIPIENT, value: BigInt(AMOUNT), address: CURRENCY })],
    })
    const ctx = buildCtx({ publicClient: stubPublicClient({ receipt: { receipt } }) })

    const out = await verifyHash({
      credential: buildCredential(),
      request: buildRequest(),
      ctx,
    })

    expect(out.method).toBe('evm')
    expect(out.status).toBe('success')
    expect(out.reference).toBe(TX_HASH)
    expect(out.challengeId).toBe(CHALLENGE_ID)
    expect(out.chainId).toBe(CHAIN_ID)
    expect(out.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    // Slot marked consumed
    const slot = await ctx.store.get(txHashKey(CHAIN_ID, TX_HASH))
    expect(slot?.state).toBe('consumed')
  })

  test('echoes externalId when present', async () => {
    const receipt = buildReceipt({
      logs: [transferLog({ from: PAYER, to: RECIPIENT, value: BigInt(AMOUNT), address: CURRENCY })],
    })
    const ctx = buildCtx({ publicClient: stubPublicClient({ receipt: { receipt } }) })

    const out = await verifyHash({
      credential: buildCredential(),
      request: buildRequest({ externalId: 'order-42' }),
      ctx,
    })
    expect(out.externalId).toBe('order-42')
  })

  test('omits externalId when absent', async () => {
    const receipt = buildReceipt({
      logs: [transferLog({ from: PAYER, to: RECIPIENT, value: BigInt(AMOUNT), address: CURRENCY })],
    })
    const ctx = buildCtx({ publicClient: stubPublicClient({ receipt: { receipt } }) })

    const out = await verifyHash({
      credential: buildCredential(),
      request: buildRequest(),
      ctx,
    })
    expect(out).not.toHaveProperty('externalId')
  })

  test('lax_from ignores credential.source even when present', async () => {
    const receipt = buildReceipt({
      logs: [transferLog({ from: PAYER, to: RECIPIENT, value: BigInt(AMOUNT), address: CURRENCY })],
    })
    const ctx = buildCtx({
      publicClient: stubPublicClient({ receipt: { receipt } }),
      hashFromPolicy: 'lax_from',
    })

    // source mismatches Transfer.from but lax_from doesn't care
    const cred = buildCredential({
      source: `did:pkh:eip155:${CHAIN_ID}:0x4444444444444444444444444444444444444444`,
    })
    await expect(
      verifyHash({ credential: cred, request: buildRequest(), ctx }),
    ).resolves.toBeDefined()
  })
})

/* -------------------------------------------------------------------------- */
/*  Step 1: replay slot pre-state checks                                      */
/* -------------------------------------------------------------------------- */

describe('verifyHash step 1 (atomic reserve)', () => {
  test('throws REPLAY when slot already consumed', async () => {
    const store = freshStore()
    // Pre-mark consumed
    await store.update(txHashKey(CHAIN_ID, TX_HASH), () => ({
      op: 'set',
      value: { state: 'consumed' as const, ts: Date.now() },
      result: true as const,
    }))
    const ctx = buildCtx({
      store,
      publicClient: stubPublicClient({ receipt: { notFound: true } }),
    })

    await expect(
      verifyHash({ credential: buildCredential(), request: buildRequest(), ctx }),
    ).rejects.toThrow(/already consumed/)
  })

  test('throws REJECTED when slot already rejected', async () => {
    const store = freshStore()
    await store.update(txHashKey(CHAIN_ID, TX_HASH), () => ({
      op: 'set',
      value: { state: 'rejected' as const, ts: Date.now(), reason: 'log mismatch from earlier' },
      result: true as const,
    }))
    const ctx = buildCtx({
      store,
      publicClient: stubPublicClient({ receipt: { notFound: true } }),
    })

    await expect(
      verifyHash({ credential: buildCredential(), request: buildRequest(), ctx }),
    ).rejects.toThrow(/previously rejected.*log mismatch from earlier/)
  })

  test('throws CONCURRENT when slot is inflight from another verify', async () => {
    const store = freshStore()
    await store.update(txHashKey(CHAIN_ID, TX_HASH), () => ({
      op: 'set',
      value: { state: 'inflight' as const, ts: Date.now() },
      result: true as const,
    }))
    const ctx = buildCtx({
      store,
      publicClient: stubPublicClient({ receipt: { notFound: true } }),
    })

    await expect(
      verifyHash({ credential: buildCredential(), request: buildRequest(), ctx }),
    ).rejects.toThrow(/concurrent verify in progress/)
  })
})

/* -------------------------------------------------------------------------- */
/*  Step 2: receipt not found                                                 */
/* -------------------------------------------------------------------------- */

describe('verifyHash step 2 (receipt not found)', () => {
  test('throws NOT_FOUND and releases the slot for retry', async () => {
    const ctx = buildCtx({
      publicClient: stubPublicClient({ receipt: { notFound: true } }),
    })
    await expect(
      verifyHash({ credential: buildCredential(), request: buildRequest(), ctx }),
    ).rejects.toThrow(/not be broadcast yet/)

    // Slot released — retry path
    const slot = await ctx.store.get(txHashKey(CHAIN_ID, TX_HASH))
    expect(slot).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/*  Step 3: insufficient confirmations                                        */
/* -------------------------------------------------------------------------- */

describe('verifyHash step 3 (insufficient confirmations)', () => {
  test('throws INSUFFICIENT and releases the slot when blockNumber too recent', async () => {
    const receipt = buildReceipt({
      blockNumber: 100n,
      logs: [
        transferLog({
          from: PAYER,
          to: RECIPIENT,
          value: BigInt(AMOUNT),
          address: CURRENCY,
          blockNumber: 100n,
        }),
      ],
    })
    const ctx = buildCtx({
      publicClient: stubPublicClient({ receipt: { receipt }, latestBlock: 100n }), // 1 confirmation
      confirmations: 12,
    })

    await expect(
      verifyHash({ credential: buildCredential(), request: buildRequest(), ctx }),
    ).rejects.toThrow(/insufficient confirmations: have 1, need 12/)

    // Released for retry
    const slot = await ctx.store.get(txHashKey(CHAIN_ID, TX_HASH))
    expect(slot).toBeNull()
  })

  test('passes when txConfirmations exactly equals required', async () => {
    const receipt = buildReceipt({
      blockNumber: 100n,
      logs: [transferLog({ from: PAYER, to: RECIPIENT, value: BigInt(AMOUNT), address: CURRENCY })],
    })
    const ctx = buildCtx({
      publicClient: stubPublicClient({ receipt: { receipt }, latestBlock: 111n }), // 12 confs exactly
      confirmations: 12,
    })

    await expect(
      verifyHash({ credential: buildCredential(), request: buildRequest(), ctx }),
    ).resolves.toBeDefined()
  })
})

/* -------------------------------------------------------------------------- */
/*  Step 4: reverted tx                                                       */
/* -------------------------------------------------------------------------- */

describe('verifyHash step 4 (tx reverted)', () => {
  test('throws REVERTED and marks rejected', async () => {
    const receipt = buildReceipt({ status: 'reverted' })
    const ctx = buildCtx({ publicClient: stubPublicClient({ receipt: { receipt } }) })

    await expect(
      verifyHash({ credential: buildCredential(), request: buildRequest(), ctx }),
    ).rejects.toThrow(/reverted on-chain/)

    const slot = await ctx.store.get(txHashKey(CHAIN_ID, TX_HASH))
    expect(slot?.state).toBe('rejected')
    expect(slot?.reason).toMatch(/reverted/)
  })
})

/* -------------------------------------------------------------------------- */
/*  Step 5: Transfer log mismatch (currency / recipient / amount)             */
/* -------------------------------------------------------------------------- */

describe('verifyHash step 5 (Transfer log mismatch → markRejected)', () => {
  test('wrong currency address → markRejected', async () => {
    const wrongToken = '0x9999999999999999999999999999999999999999' as const
    const receipt = buildReceipt({
      logs: [
        transferLog({ from: PAYER, to: RECIPIENT, value: BigInt(AMOUNT), address: wrongToken }),
      ],
    })
    const ctx = buildCtx({ publicClient: stubPublicClient({ receipt: { receipt } }) })

    await expect(
      verifyHash({ credential: buildCredential(), request: buildRequest(), ctx }),
    ).rejects.toThrow(/no matching Transfer event/)

    expect((await ctx.store.get(txHashKey(CHAIN_ID, TX_HASH)))?.state).toBe('rejected')
  })

  test('wrong recipient → markRejected', async () => {
    const wrongRecipient = '0x8888888888888888888888888888888888888888' as const
    const receipt = buildReceipt({
      logs: [
        transferLog({ from: PAYER, to: wrongRecipient, value: BigInt(AMOUNT), address: CURRENCY }),
      ],
    })
    const ctx = buildCtx({ publicClient: stubPublicClient({ receipt: { receipt } }) })

    await expect(
      verifyHash({ credential: buildCredential(), request: buildRequest(), ctx }),
    ).rejects.toThrow(/no matching Transfer event/)

    expect((await ctx.store.get(txHashKey(CHAIN_ID, TX_HASH)))?.state).toBe('rejected')
  })

  test('wrong amount → markRejected', async () => {
    const receipt = buildReceipt({
      logs: [transferLog({ from: PAYER, to: RECIPIENT, value: 999n, address: CURRENCY })], // amount mismatch
    })
    const ctx = buildCtx({ publicClient: stubPublicClient({ receipt: { receipt } }) })

    await expect(
      verifyHash({ credential: buildCredential(), request: buildRequest(), ctx }),
    ).rejects.toThrow(/no matching Transfer event/)

    expect((await ctx.store.get(txHashKey(CHAIN_ID, TX_HASH)))?.state).toBe('rejected')
  })

  test('accepts mixed-case address from on-chain log (lowercase comparison)', async () => {
    // Some chains return EIP-55-mixed-case from RPC; verifier must normalize.
    // Use the same address but supplied uppercase-prefixed.
    const upperCurrency = `0x${CURRENCY.slice(2).toUpperCase()}` as `0x${string}`
    const receipt = buildReceipt({
      logs: [
        transferLog({ from: PAYER, to: RECIPIENT, value: BigInt(AMOUNT), address: upperCurrency }),
      ],
    })
    const ctx = buildCtx({ publicClient: stubPublicClient({ receipt: { receipt } }) })

    await expect(
      verifyHash({ credential: buildCredential(), request: buildRequest(), ctx }),
    ).resolves.toBeDefined()
  })
})

/* -------------------------------------------------------------------------- */
/*  Step 6: strict_from policy                                                */
/* -------------------------------------------------------------------------- */

describe('verifyHash step 6 (strict_from policy)', () => {
  test('happy path: matching credential.source → success', async () => {
    const receipt = buildReceipt({
      logs: [transferLog({ from: PAYER, to: RECIPIENT, value: BigInt(AMOUNT), address: CURRENCY })],
    })
    const ctx = buildCtx({
      publicClient: stubPublicClient({ receipt: { receipt } }),
      hashFromPolicy: 'strict_from',
    })

    const cred = buildCredential({ source: `did:pkh:eip155:${CHAIN_ID}:${PAYER}` })
    await expect(
      verifyHash({ credential: cred, request: buildRequest(), ctx }),
    ).resolves.toBeDefined()
  })

  test('missing credential.source → markRejected with explicit message', async () => {
    const receipt = buildReceipt({
      logs: [transferLog({ from: PAYER, to: RECIPIENT, value: BigInt(AMOUNT), address: CURRENCY })],
    })
    const ctx = buildCtx({
      publicClient: stubPublicClient({ receipt: { receipt } }),
      hashFromPolicy: 'strict_from',
    })

    await expect(
      verifyHash({ credential: buildCredential(), request: buildRequest(), ctx }),
    ).rejects.toThrow(/requires credential.source/)

    expect((await ctx.store.get(txHashKey(CHAIN_ID, TX_HASH)))?.state).toBe('rejected')
  })

  test('credential.source format wrong → markRejected', async () => {
    const receipt = buildReceipt({
      logs: [transferLog({ from: PAYER, to: RECIPIENT, value: BigInt(AMOUNT), address: CURRENCY })],
    })
    const ctx = buildCtx({
      publicClient: stubPublicClient({ receipt: { receipt } }),
      hashFromPolicy: 'strict_from',
    })

    const cred = buildCredential({ source: 'not-a-did' })
    await expect(verifyHash({ credential: cred, request: buildRequest(), ctx })).rejects.toThrow(
      /must match 'did:pkh:eip155/,
    )

    expect((await ctx.store.get(txHashKey(CHAIN_ID, TX_HASH)))?.state).toBe('rejected')
  })

  test('credential.source address ≠ Transfer.from → markRejected', async () => {
    const receipt = buildReceipt({
      logs: [transferLog({ from: PAYER, to: RECIPIENT, value: BigInt(AMOUNT), address: CURRENCY })],
    })
    const ctx = buildCtx({
      publicClient: stubPublicClient({ receipt: { receipt } }),
      hashFromPolicy: 'strict_from',
    })

    const cred = buildCredential({
      source: `did:pkh:eip155:${CHAIN_ID}:0x4444444444444444444444444444444444444444`,
    })
    await expect(verifyHash({ credential: cred, request: buildRequest(), ctx })).rejects.toThrow(
      /Transfer.from .* does not match credential.source/,
    )

    expect((await ctx.store.get(txHashKey(CHAIN_ID, TX_HASH)))?.state).toBe('rejected')
  })
})

/* -------------------------------------------------------------------------- */
/*  Error class                                                               */
/* -------------------------------------------------------------------------- */

describe('verifyHash error class', () => {
  test('all failure modes throw Errors.VerificationFailedError', async () => {
    const ctx = buildCtx({
      publicClient: stubPublicClient({ receipt: { notFound: true } }),
    })
    await expect(
      verifyHash({ credential: buildCredential(), request: buildRequest(), ctx }),
    ).rejects.toBeInstanceOf(Errors.VerificationFailedError)
  })
})

/* -------------------------------------------------------------------------- */
/*  Terminal-phase store-write failure must NOT release slot                   */
/* -------------------------------------------------------------------------- */

describe('verifyHash — terminal-phase store-write failure keeps slot inflight', () => {
  test('markConsumed fails on all retries → slot stays inflight (no release, no double-spend window)', async () => {
    // Properly-typed shared helper (see test/helpers/server/terminalFailureStore.ts).
    // Models a SUSTAINED Redis outage at the markConsumed CAS — every one
    // of consumeSlotBestEffort's 3 attempts fails. Previously the outer
    // safety net would release() the slot — and the user could replay the
    // same txHash for a SECOND match → double-spend.
    const receipt = buildReceipt({
      logs: [transferLog({ from: PAYER, to: RECIPIENT, value: BigInt(AMOUNT), address: CURRENCY })],
    })
    const store = terminalFailureStore({
      failOn: failOnState('consumed'),
      message: 'ECONNRESET: Redis dropped right at markConsumed',
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const ctx = buildCtx({
        store,
        publicClient: stubPublicClient({ receipt: { receipt } }),
      })

      // The payment is confirmed on-chain — the paid payer gets their
      // receipt even though the consumed-write failed. The slot staying
      // inflight still blocks replay.
      const out = await verifyHash({ credential: buildCredential(), request: buildRequest(), ctx })
      expect(out.status).toBe('success')
      expect(out.reference).toBe(TX_HASH)

      // CRITICAL: slot remains inflight. Releasing here would re-admit the
      // SAME txHash for another verify cycle — the tx already matched once,
      // so it would match again → double-spend.
      const slot = await store.get(txHashKey(CHAIN_ID, TX_HASH))
      expect(slot?.state).toBe('inflight')

      // Operator hint surfaces in console.warn so the inflight slot isn't
      // a silent leak — this exact fragment is the operator alert string
      // documented in docs/replay-store.md.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/markConsumed failed after 3 attempts.*remains inflight/),
        expect.any(String),
      )
      expect(warnSpy.mock.calls[0]?.[0]).toContain('[verifyHash]')
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('markConsumed transient blip → retry succeeds, slot lands consumed, no warn', async () => {
    // consumeSlotBestEffort retries markConsumed 3x — a one-off CAS
    // failure (Redis blip) must end with the slot terminally `consumed`
    // and NO operator warn (nothing to alert on; the retry closed it).
    const receipt = buildReceipt({
      logs: [transferLog({ from: PAYER, to: RECIPIENT, value: BigInt(AMOUNT), address: CURRENCY })],
    })
    let consumedAttempts = 0
    const store = terminalFailureStore({
      failOn: (probe) => failOnState('consumed')(probe) && ++consumedAttempts === 1,
      message: 'ECONNRESET: Redis blipped once at markConsumed',
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const ctx = buildCtx({
        store,
        publicClient: stubPublicClient({ receipt: { receipt } }),
      })

      const out = await verifyHash({ credential: buildCredential(), request: buildRequest(), ctx })
      expect(out.status).toBe('success')

      const slot = await store.get(txHashKey(CHAIN_ID, TX_HASH))
      expect(slot?.state).toBe('consumed')
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('markRejected throws on post-success log-mismatch → slot stays inflight (no release)', async () => {
    // The OTHER terminal branch for Hash: tx exists on-chain (receipt
    // fetched + confirmations satisfied) but the Transfer log doesn't
    // match — verifier enters the markRejected path (Hash.ts step 5
    // mismatch). The hash credential is now permanently rejected; if
    // markRejected fails (Redis flaky right then), the
    // terminalPhase=true flag must STILL prevent the safety-net release. A
    // released slot would re-admit the same hash → next attempt would
    // re-fetch the same on-chain tx → same log mismatch → another
    // markRejected attempt (which also fails). Worse, between the
    // failure and the eventual TTL, an observer that thinks "free
    // slot ≡ untried credential" could mistakenly treat the hash as
    // fresh evidence.
    const wrongRecipient = '0x7777777777777777777777777777777777777777' as const
    const receipt = buildReceipt({
      logs: [
        transferLog({ from: PAYER, to: wrongRecipient, value: BigInt(AMOUNT), address: CURRENCY }),
      ],
    })
    const store = terminalFailureStore({
      failOn: failOnState('rejected'),
      message: 'ECONNRESET: Redis dropped right at markRejected',
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const ctx = buildCtx({
        store,
        publicClient: stubPublicClient({ receipt: { receipt } }),
      })

      await expect(
        verifyHash({ credential: buildCredential(), request: buildRequest(), ctx }),
      ).rejects.toThrow(/ECONNRESET: Redis dropped right at markRejected/)

      const slot = await store.get(txHashKey(CHAIN_ID, TX_HASH))
      expect(slot?.state).toBe('inflight')
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/terminal-phase store write failed.*slot remains inflight/),
        expect.any(String),
      )
    } finally {
      warnSpy.mockRestore()
    }
  })
})
