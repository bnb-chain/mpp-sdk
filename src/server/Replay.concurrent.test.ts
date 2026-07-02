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
 *   4. CROSS-TYPE replay (spec §8): `transaction` and `hash` credentials
 *      share ONE txHashKey keyspace — a transfer settled via one type is
 *      not redeemable again via the other.
 *   5. N parallel verifyPermit2() on the same (signer, nonce) → exactly 1
 *      settles; the on-chain writeContract fires exactly ONCE (the
 *      gas-burning double-broadcast guard).
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
  type WalletClient,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  keccak256,
  parseGwei,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { signTypedData } from 'viem/actions'
import { describe, expect, test, vi } from 'vitest'

import { computeChallengeHash, permit2Domain, permit2SingleTypes } from '../protocol/TypedData.js'
import { verifyHash } from './Hash.js'
import { type Permit2VerifierArgs, type Permit2VerifierCtx, verifyPermit2 } from './Permit2.js'
import { type ChargeStore, permit2Key, reserve, txHashKey } from './Replay.js'
import { type TransactionVerifierArgs, verifyTransaction } from './Transaction.js'

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
    const key = txHashKey(CHAIN_ID, TX)
    const N = 50

    const results = await Promise.all(Array.from({ length: N }, () => reserve(store, key)))
    const winners = results.filter((r) => r !== null)
    const losers = results.filter((r) => r === null)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(N - 1)
  })

  test('N parallel reserves on DIFFERENT keys → all win', async () => {
    const store = freshStore()
    const N = 20
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => {
        const tx = `0x${i.toString(16).padStart(64, '0')}` as `0x${string}`
        return reserve(store, txHashKey(CHAIN_ID, tx))
      }),
    )
    expect(results.every((r) => r !== null)).toBe(true)
  })

  test('reserve → reserve on same key returns false (sequential sanity)', async () => {
    const store = freshStore()
    const key = txHashKey(CHAIN_ID, TX)
    expect(await reserve(store, key)).not.toBeNull()
    expect(await reserve(store, key)).toBeNull()
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

function transferLog(args: {
  from: `0x${string}`
  to: `0x${string}`
  value: bigint
  address: `0x${string}`
  txHash?: `0x${string}`
}): Log {
  const { from, to, value, address, txHash = TX } = args
  return {
    address,
    blockHash: `0x${'a'.repeat(64)}` as `0x${string}`,
    blockNumber: 100n,
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
    logIndex: 0,
    removed: false,
    topics: encodeEventTopics({
      abi: TRANSFER_ABI,
      eventName: 'Transfer',
      args: { from, to },
    }) as Log['topics'],
    transactionHash: txHash,
    transactionIndex: 0,
  } as Log
}

function happyReceipt(
  overrides: { txHash?: `0x${string}`; from?: `0x${string}` } = {},
): TransactionReceipt {
  const txHash = overrides.txHash ?? TX
  const from = overrides.from ?? PAYER
  return {
    blockHash: `0x${'b'.repeat(64)}`,
    blockNumber: 100n,
    contractAddress: null,
    cumulativeGasUsed: 0n,
    effectiveGasPrice: 0n,
    from,
    gasUsed: 0n,
    logs: [transferLog({ from, to: RECIPIENT, value: BigInt(AMOUNT), address: CURRENCY, txHash })],
    logsBloom: '0x',
    status: 'success' as const,
    to: CURRENCY,
    transactionHash: txHash,
    transactionIndex: 0,
    type: 'eip1559' as const,
  } as unknown as TransactionReceipt
}

function stubPublicClient(receipt: TransactionReceipt = happyReceipt()): PublicClient {
  return {
    async getTransactionReceipt() {
      return receipt
    },
    async getBlockNumber() {
      return 100n
    },
    // Used only by the verifyTransaction path (cross-type test).
    async sendRawTransaction() {
      return receipt.transactionHash
    },
    async waitForTransactionReceipt() {
      return receipt
    },
  } as unknown as PublicClient
}

function buildCredential(overrides: { hash?: `0x${string}`; challengeId?: string } = {}) {
  return {
    challenge: {
      id: overrides.challengeId ?? 'chal_concurrent',
      realm: 'https://test.example/',
      method: 'evm',
      intent: 'charge',
      request: { amount: AMOUNT, currency: CURRENCY, recipient: RECIPIENT },
      expires: new Date(Date.now() + 60_000).toISOString(),
    },
    payload: { type: 'hash', hash: overrides.hash ?? TX },
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
    const final = await store.get(txHashKey(CHAIN_ID, TX))
    expect(final?.state).toBe('consumed')
  })
})

/* -------------------------------------------------------------------------- */
/*  Cross-type replay: transaction + hash share ONE txHashKey keyspace        */
/* -------------------------------------------------------------------------- */

/**
 * Payer account for the cross-type test — the `transaction` verifier
 * recovers the sender from the signed RLP, so the receipt's Transfer log
 * must carry this account's address as `from`.
 */
const PAYER_PK = '0x0505050505050505050505050505050505050505050505050505050505050505' as const
const PAYER_ACCOUNT = privateKeyToAccount(PAYER_PK)

const ERC20_TRANSFER_FN_ABI = [
  {
    type: 'function',
    name: 'transfer',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
    stateMutability: 'nonpayable',
  },
] as const

/** Sign a REAL ERC-20 transfer RLP matching the test challenge. */
async function signERC20TransferTx(): Promise<`0x${string}`> {
  return PAYER_ACCOUNT.signTransaction({
    chainId: CHAIN_ID,
    to: CURRENCY,
    value: 0n,
    data: encodeFunctionData({
      abi: ERC20_TRANSFER_FN_ABI,
      functionName: 'transfer',
      args: [RECIPIENT, BigInt(AMOUNT)],
    }),
    nonce: 0,
    type: 'eip1559',
    gas: 100_000n,
    maxFeePerGas: parseGwei('30'),
    maxPriorityFeePerGas: parseGwei('1'),
  })
}

describe('cross-type replay — transaction and hash credentials share the txHash keyspace', () => {
  test('store-level: after verifyHash settles H, reserve(txHashKey(H)) returns false', async () => {
    const store = freshStore()
    const ctx: Parameters<typeof verifyHash>[0]['ctx'] = {
      publicClient: stubPublicClient(),
      store,
      chainId: CHAIN_ID,
      confirmations: 0,
      hashFromPolicy: 'lax_from' as const,
    }
    const request = { amount: AMOUNT, currency: CURRENCY, recipient: RECIPIENT }

    await verifyHash({ credential: buildCredential(), request, ctx })

    // The SAME key factory serves BOTH credential types (spec §8): a
    // `transaction` credential for this tx would reserve this exact key,
    // so its reserve must lose against the hash-settled slot.
    expect(await reserve(store, txHashKey(CHAIN_ID, TX))).toBeNull()
    expect((await store.get(txHashKey(CHAIN_ID, TX)))?.state).toBe('consumed')
  })

  test('end-to-end: tx settled via verifyTransaction is NOT redeemable as a hash credential', async () => {
    const store = freshStore()
    const rawTx = await signERC20TransferTx()
    const h2 = keccak256(rawTx)
    // One stub serves both verifiers: sendRawTransaction +
    // waitForTransactionReceipt for the transaction path,
    // getTransactionReceipt + getBlockNumber for the hash path.
    const publicClient = stubPublicClient(happyReceipt({ txHash: h2, from: PAYER_ACCOUNT.address }))
    const request = { amount: AMOUNT, currency: CURRENCY, recipient: RECIPIENT }

    // Settle the transfer in the constructible direction: the signed RLP
    // is presented as a `transaction` credential.
    const out = await verifyTransaction({
      credential: {
        challenge: {
          id: 'chal_tx_settles_first',
          realm: 'https://test.example/',
          method: 'evm',
          intent: 'charge',
          request,
          expires: new Date(Date.now() + 60_000).toISOString(),
        },
        payload: { type: 'transaction', signature: rawTx },
      } as unknown as TransactionVerifierArgs['credential'],
      request,
      ctx: { publicClient, store, chainId: CHAIN_ID, confirmations: 0 },
    })
    expect(out.reference).toBe(h2)
    expect((await store.get(txHashKey(CHAIN_ID, h2)))?.state).toBe('consumed')

    // Now present the SAME on-chain transfer as a `hash` credential against
    // a SECOND equal-priced challenge — the shared keyspace must reject it.
    await expect(
      verifyHash({
        credential: buildCredential({ hash: h2, challengeId: 'chal_hash_replays_second' }),
        request,
        ctx: {
          publicClient,
          store,
          chainId: CHAIN_ID,
          confirmations: 0,
          hashFromPolicy: 'lax_from' as const,
        },
      }),
    ).rejects.toThrow(/already consumed/)
  })
})

/* -------------------------------------------------------------------------- */
/*  Concurrent verifyPermit2: the gas-burning double-broadcast guard          */
/* -------------------------------------------------------------------------- */

/**
 * Minimal local Permit2 fixtures (modeled on Permit2.test.ts — re-created
 * here rather than imported across test files).
 */
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3' as const
const P2_SIGNER_PK = '0x0606060606060606060606060606060606060606060606060606060606060606' as const
const P2_SIGNER_ACCOUNT = privateKeyToAccount(P2_SIGNER_PK)
const P2_SIGNER = P2_SIGNER_ACCOUNT.address
const P2_SETTLEMENT_PK =
  '0x0707070707070707070707070707070707070707070707070707070707070707' as const
const P2_SETTLEMENT_ACCOUNT = privateKeyToAccount(P2_SETTLEMENT_PK)
const P2_SETTLEMENT_ADDR = P2_SETTLEMENT_ACCOUNT.address
const P2_NONCE = '777'
const P2_DEADLINE = String(Math.floor(Date.now() / 1000) + 600)
const P2_REALM = 'https://test.example/'
const P2_CHALLENGE_ID = 'chal_permit2_concurrent'
const P2_CHALLENGE_HASH = computeChallengeHash(P2_CHALLENGE_ID, P2_REALM)

/** Sign the Permit2 single typed-data with the test signer key. */
async function signSinglePermit(): Promise<`0x${string}`> {
  return signTypedData(
    { type: 'local', account: P2_SIGNER_ACCOUNT } as unknown as Parameters<typeof signTypedData>[0],
    {
      account: P2_SIGNER_ACCOUNT,
      domain: permit2Domain(CHAIN_ID, PERMIT2),
      types: permit2SingleTypes,
      primaryType: 'PermitWitnessTransferFrom',
      message: {
        permitted: { token: CURRENCY, amount: BigInt(AMOUNT) },
        spender: P2_SETTLEMENT_ADDR,
        nonce: BigInt(P2_NONCE),
        deadline: BigInt(P2_DEADLINE),
        witness: { challengeHash: P2_CHALLENGE_HASH },
      },
    },
  )
}

function buildPermit2Credential(signature: `0x${string}`): Permit2VerifierArgs['credential'] {
  return {
    challenge: {
      id: P2_CHALLENGE_ID,
      realm: P2_REALM,
      method: 'evm',
      intent: 'charge',
      request: { amount: AMOUNT, currency: CURRENCY, recipient: RECIPIENT },
      expires: new Date(Date.now() + 60_000).toISOString(),
    },
    payload: {
      type: 'permit2',
      permit: {
        permitted: [{ token: CURRENCY, amount: AMOUNT }],
        nonce: P2_NONCE,
        deadline: P2_DEADLINE,
      },
      transferDetails: [{ to: RECIPIENT, requestedAmount: AMOUNT }],
      witness: { challengeHash: P2_CHALLENGE_HASH },
      signature,
    },
    source: `did:pkh:eip155:${CHAIN_ID}:${P2_SIGNER}`,
  } as unknown as Permit2VerifierArgs['credential']
}

const permit2Request: Permit2VerifierArgs['request'] = {
  amount: AMOUNT,
  currency: CURRENCY,
  recipient: RECIPIENT,
  methodDetails: { permit2Address: PERMIT2, permit2Spender: P2_SETTLEMENT_ADDR },
}

function stubPermit2PublicClient(receipt: TransactionReceipt): PublicClient {
  return {
    async readContract({ functionName }: { functionName: string }) {
      if (functionName === 'balanceOf') return BigInt(AMOUNT) * 10n
      if (functionName === 'allowance') return BigInt(AMOUNT) * 10n
      throw new Error(`unexpected readContract: ${functionName}`)
    },
    async simulateContract() {
      return { result: undefined, request: {} }
    },
    async waitForTransactionReceipt() {
      return receipt
    },
  } as unknown as PublicClient
}

function permit2SettlementReceipt(): TransactionReceipt {
  return {
    blockHash: `0x${'c'.repeat(64)}`,
    blockNumber: 100n,
    contractAddress: null,
    cumulativeGasUsed: 0n,
    effectiveGasPrice: 0n,
    from: P2_SETTLEMENT_ADDR,
    gasUsed: 0n,
    logs: [
      transferLog({ from: P2_SIGNER, to: RECIPIENT, value: BigInt(AMOUNT), address: CURRENCY }),
    ],
    logsBloom: '0x',
    status: 'success' as const,
    to: PERMIT2,
    transactionHash: `0x${'d'.repeat(64)}`,
    transactionIndex: 0,
    type: 'eip1559' as const,
  } as unknown as TransactionReceipt
}

describe('verifyPermit2 — concurrent double-broadcast rejection', () => {
  test('N parallel verifyPermit2 on same (signer, nonce) → 1 success + exactly ONE writeContract', async () => {
    const store = freshStore()
    const sig = await signSinglePermit()

    // The settlement broadcast is the gas-burning step: each writeContract
    // costs the operator real gas (and all but the first revert with
    // InvalidNonce on-chain). The reserve CAS must funnel N concurrent
    // verifies into exactly ONE broadcast.
    const writeContract = vi.fn(async () => `0x${'d'.repeat(64)}` as `0x${string}`)
    const settlementSigner = {
      account: P2_SETTLEMENT_ACCOUNT,
      chain: null,
      writeContract,
    } as unknown as WalletClient

    const ctx: Permit2VerifierCtx = {
      publicClient: stubPermit2PublicClient(permit2SettlementReceipt()),
      store,
      chainId: CHAIN_ID,
      settlementSigner,
      confirmations: 0,
    }

    const N = 10
    const settled = await Promise.allSettled(
      Array.from({ length: N }, () =>
        verifyPermit2({ credential: buildPermit2Credential(sig), request: permit2Request, ctx }),
      ),
    )

    const fulfilled = settled.filter((r) => r.status === 'fulfilled')
    const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected')

    // Exactly 1 of N settles.
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(N - 1)
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(Errors.VerificationFailedError)
      expect((r.reason as Error).message).toMatch(/concurrent verify in progress|already consumed/)
    }

    // The double-broadcast guard: ONE on-chain settlement call, total.
    expect(writeContract).toHaveBeenCalledTimes(1)

    // Final state: the (signer, nonce) slot is consumed.
    expect((await store.get(permit2Key(CHAIN_ID, PERMIT2, P2_SIGNER, P2_NONCE)))?.state).toBe(
      'consumed',
    )
  })
})
