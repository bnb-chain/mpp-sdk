/**
 * Settlement-knob plumbing tests — `ctx.settlementTimeoutMs` and
 * `ctx.inflightTtlMs` ABOVE the Replay primitive.
 *
 * `Replay.test.ts` covers reserve()'s stale-inflight reclaim in isolation,
 * but nothing previously asserted that the verifiers actually FORWARD the
 * two knobs: deleting the `timeout:` spread in a verifier (or dropping
 * `{ inflightTtlMs }` from its reserve() call) kept the whole suite green.
 * This file builds each verifier ctx directly and pins the plumbing:
 *
 *   - settlementTimeoutMs → `waitForTransactionReceipt({ timeout })` for
 *     each settling verifier (permit2 / authorization / transaction).
 *     Unset → the `timeout` key is ABSENT (viem's 180s default applies);
 *     the verifiers spread conditionally, so `timeout: undefined` must
 *     never be passed either.
 *   - inflightTtlMs → reserve()'s reclaim age, exercised end-to-end via
 *     verifyHash (the cheapest verifier): a 5s-old inflight slot is
 *     reclaimed under ctx.inflightTtlMs = 1000 and the verify settles;
 *     with the knob unset the 10min default keeps the slot held and the
 *     verify rejects "concurrent verify in progress".
 */

import { Store } from 'mppx'
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
import { describe, expect, test } from 'vitest'

import {
  computeChallengeHash,
  eip3009Domain,
  eip3009Nonce,
  eip3009Types,
  permit2Domain,
  permit2SingleTypes,
} from '../protocol/TypedData.js'
import {
  type AuthorizationVerifierArgs,
  type AuthorizationVerifierCtx,
  verifyAuthorization,
} from './Authorization.js'
import { type HashVerifierArgs, type HashVerifierCtx, verifyHash } from './Hash.js'
import { type Permit2VerifierArgs, type Permit2VerifierCtx, verifyPermit2 } from './Permit2.js'
import { type ChargeStore, txHashKey } from './Replay.js'
import {
  type TransactionVerifierArgs,
  type TransactionVerifierCtx,
  verifyTransaction,
} from './Transaction.js'

/* -------------------------------------------------------------------------- */
/*  Shared fixtures                                                           */
/* -------------------------------------------------------------------------- */

const CHAIN_ID = 1
const CURRENCY = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const // USDC
const RECIPIENT = '0x2222222222222222222222222222222222222222' as const
const AMOUNT = '1000000'
const REALM = 'https://test.example/'
const TIMEOUT_MS = 12_345

const PK = '0x0707070707070707070707070707070707070707070707070707070707070707' as const
const ACCOUNT = privateKeyToAccount(PK)
const SIGNER = ACCOUNT.address

const SETTLEMENT_PK = '0x0808080808080808080808080808080808080808080808080808080808080808' as const
const SETTLEMENT_ACCOUNT = privateKeyToAccount(SETTLEMENT_PK)
const SETTLEMENT_ADDR = SETTLEMENT_ACCOUNT.address

function freshStore(): ChargeStore {
  return Store.memory() as unknown as ChargeStore
}

const TRANSFER_EVENT_ABI = [
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
}): Log {
  const { from, to, value, address } = args
  return {
    address,
    blockHash: `0x${'a'.repeat(64)}` as `0x${string}`,
    blockNumber: 100n,
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
    logIndex: 0,
    removed: false,
    topics: encodeEventTopics({
      abi: TRANSFER_EVENT_ABI,
      eventName: 'Transfer',
      args: { from, to },
    }) as Log['topics'],
    transactionHash: `0x${'b'.repeat(64)}` as `0x${string}`,
    transactionIndex: 0,
  } as Log
}

function buildReceipt(args: { logs: Log[]; txHash?: `0x${string}` }): TransactionReceipt {
  const { logs, txHash = `0x${'c'.repeat(64)}` } = args
  return {
    blockHash: `0x${'d'.repeat(64)}` as `0x${string}`,
    blockNumber: 100n,
    contractAddress: null,
    cumulativeGasUsed: 0n,
    effectiveGasPrice: 0n,
    from: SETTLEMENT_ADDR,
    gasUsed: 0n,
    logs,
    logsBloom: '0x' as `0x${string}`,
    status: 'success',
    to: CURRENCY,
    transactionHash: txHash,
    transactionIndex: 0,
    type: 'eip1559',
  } as TransactionReceipt
}

/** Args object viem's waitForTransactionReceipt was called with. */
interface CapturedWaitArgs {
  hash: `0x${string}`
  confirmations?: number
  timeout?: number
}

function stubWalletClient(): WalletClient {
  return {
    account: SETTLEMENT_ACCOUNT,
    chain: null,
    async writeContract() {
      return `0x${'e'.repeat(64)}`
    },
  } as unknown as WalletClient
}

/* -------------------------------------------------------------------------- */
/*  permit2: settlementTimeoutMs → waitForTransactionReceipt timeout          */
/* -------------------------------------------------------------------------- */

describe('settlementTimeoutMs plumbing — verifyPermit2', () => {
  const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3' as const
  const NONCE = '12345'
  const DEADLINE = String(Math.floor(Date.now() / 1000) + 600)
  const CHALLENGE_ID = 'chal_knobs_permit2'
  const CHALLENGE_HASH = computeChallengeHash(CHALLENGE_ID, REALM)

  function stubPublicClient(waitCalls: CapturedWaitArgs[]): PublicClient {
    const receipt = buildReceipt({
      logs: [
        transferLog({ from: SIGNER, to: RECIPIENT, value: BigInt(AMOUNT), address: CURRENCY }),
      ],
    })
    return {
      async readContract({ functionName }: { functionName: string }) {
        if (functionName === 'balanceOf') return BigInt(AMOUNT) * 10n
        if (functionName === 'allowance') return BigInt(AMOUNT) * 10n
        throw new Error(`unexpected readContract: ${functionName}`)
      },
      async simulateContract() {
        return { result: undefined, request: {} }
      },
      async waitForTransactionReceipt(args: CapturedWaitArgs) {
        waitCalls.push(args)
        return receipt
      },
    } as unknown as PublicClient
  }

  async function buildArgs(waitCalls: CapturedWaitArgs[], settlementTimeoutMs?: number) {
    const signature = await signTypedData(
      { type: 'local', account: ACCOUNT } as unknown as Parameters<typeof signTypedData>[0],
      {
        account: ACCOUNT,
        domain: permit2Domain(CHAIN_ID, PERMIT2),
        types: permit2SingleTypes,
        primaryType: 'PermitWitnessTransferFrom',
        message: {
          permitted: { token: CURRENCY, amount: BigInt(AMOUNT) },
          spender: SETTLEMENT_ADDR,
          nonce: BigInt(NONCE),
          deadline: BigInt(DEADLINE),
          witness: { challengeHash: CHALLENGE_HASH, externalId: '' },
        },
      },
    )
    const credential = {
      challenge: {
        id: CHALLENGE_ID,
        realm: REALM,
        method: 'evm',
        intent: 'charge',
        request: { amount: AMOUNT, currency: CURRENCY, recipient: RECIPIENT },
        expires: new Date(Date.now() + 60_000).toISOString(),
      },
      payload: {
        type: 'permit2',
        permit: {
          permitted: [{ token: CURRENCY, amount: AMOUNT }],
          nonce: NONCE,
          deadline: DEADLINE,
        },
        transferDetails: [{ to: RECIPIENT, requestedAmount: AMOUNT }],
        witness: { challengeHash: CHALLENGE_HASH, externalId: '' },
        signature,
      },
      source: `did:pkh:eip155:${CHAIN_ID}:${SIGNER}`,
    } as unknown as Permit2VerifierArgs['credential']
    const request: Permit2VerifierArgs['request'] = {
      amount: AMOUNT,
      currency: CURRENCY,
      recipient: RECIPIENT,
      methodDetails: { permit2Address: PERMIT2, permit2Spender: SETTLEMENT_ADDR },
    }
    const ctx: Permit2VerifierCtx = {
      publicClient: stubPublicClient(waitCalls),
      store: freshStore(),
      chainId: CHAIN_ID,
      settlementSigner: stubWalletClient(),
      confirmations: 1,
      ...(settlementTimeoutMs !== undefined && { settlementTimeoutMs }),
    }
    return { credential, request, ctx }
  }

  test('set → waitForTransactionReceipt receives timeout === ctx.settlementTimeoutMs', async () => {
    const waitCalls: CapturedWaitArgs[] = []
    const args = await buildArgs(waitCalls, TIMEOUT_MS)
    await expect(verifyPermit2(args)).resolves.toBeDefined()
    expect(waitCalls).toHaveLength(1)
    expect(waitCalls[0]!.timeout).toBe(TIMEOUT_MS)
  })

  test('unset → timeout key is absent (viem default applies)', async () => {
    const waitCalls: CapturedWaitArgs[] = []
    const args = await buildArgs(waitCalls)
    await expect(verifyPermit2(args)).resolves.toBeDefined()
    expect(waitCalls).toHaveLength(1)
    expect(waitCalls[0]!.timeout).toBeUndefined()
    expect(waitCalls[0]).not.toHaveProperty('timeout')
  })
})

/* -------------------------------------------------------------------------- */
/*  authorization: settlementTimeoutMs → waitForTransactionReceipt timeout    */
/* -------------------------------------------------------------------------- */

describe('settlementTimeoutMs plumbing — verifyAuthorization', () => {
  const TOKEN_NAME = 'USD Coin'
  const TOKEN_VERSION = '2'
  const CHALLENGE_ID = 'chal_knobs_auth'
  const NONCE = eip3009Nonce(CHALLENGE_ID, REALM)
  const NOW = Math.floor(Date.now() / 1000)
  const VALID_AFTER = String(NOW - 60)
  const VALID_BEFORE = String(NOW + 600)

  function stubPublicClient(waitCalls: CapturedWaitArgs[]): PublicClient {
    const receipt = buildReceipt({
      logs: [
        transferLog({ from: SIGNER, to: RECIPIENT, value: BigInt(AMOUNT), address: CURRENCY }),
      ],
    })
    return {
      async readContract({ functionName }: { functionName: string }) {
        if (functionName === 'balanceOf') return BigInt(AMOUNT) * 10n
        throw new Error(`unexpected readContract: ${functionName}`)
      },
      async simulateContract() {
        return { result: undefined, request: {} }
      },
      async waitForTransactionReceipt(args: CapturedWaitArgs) {
        waitCalls.push(args)
        return receipt
      },
    } as unknown as PublicClient
  }

  async function buildArgs(waitCalls: CapturedWaitArgs[], settlementTimeoutMs?: number) {
    const signature = await signTypedData(
      { type: 'local', account: ACCOUNT } as unknown as Parameters<typeof signTypedData>[0],
      {
        account: ACCOUNT,
        domain: eip3009Domain({
          tokenName: TOKEN_NAME,
          tokenVersion: TOKEN_VERSION,
          chainId: CHAIN_ID,
          tokenAddress: CURRENCY,
        }),
        types: eip3009Types,
        primaryType: 'TransferWithAuthorization',
        message: {
          from: SIGNER,
          to: RECIPIENT,
          value: BigInt(AMOUNT),
          validAfter: BigInt(VALID_AFTER),
          validBefore: BigInt(VALID_BEFORE),
          nonce: NONCE,
        },
      },
    )
    const credential = {
      challenge: {
        id: CHALLENGE_ID,
        realm: REALM,
        method: 'evm',
        intent: 'charge',
        request: { amount: AMOUNT, currency: CURRENCY, recipient: RECIPIENT },
        expires: new Date(Date.now() + 60_000).toISOString(),
      },
      payload: {
        type: 'authorization',
        from: SIGNER,
        to: RECIPIENT,
        value: AMOUNT,
        validAfter: VALID_AFTER,
        validBefore: VALID_BEFORE,
        nonce: NONCE,
        signature,
      },
    } as unknown as AuthorizationVerifierArgs['credential']
    const request: AuthorizationVerifierArgs['request'] = {
      amount: AMOUNT,
      currency: CURRENCY,
      recipient: RECIPIENT,
    }
    const ctx: AuthorizationVerifierCtx = {
      publicClient: stubPublicClient(waitCalls),
      store: freshStore(),
      chainId: CHAIN_ID,
      settlementSigner: stubWalletClient(),
      eip712: { name: TOKEN_NAME, version: TOKEN_VERSION },
      confirmations: 1,
      ...(settlementTimeoutMs !== undefined && { settlementTimeoutMs }),
    }
    return { credential, request, ctx }
  }

  test('set → waitForTransactionReceipt receives timeout === ctx.settlementTimeoutMs', async () => {
    const waitCalls: CapturedWaitArgs[] = []
    const args = await buildArgs(waitCalls, TIMEOUT_MS)
    await expect(verifyAuthorization(args)).resolves.toBeDefined()
    expect(waitCalls).toHaveLength(1)
    expect(waitCalls[0]!.timeout).toBe(TIMEOUT_MS)
  })

  test('unset → timeout key is absent (viem default applies)', async () => {
    const waitCalls: CapturedWaitArgs[] = []
    const args = await buildArgs(waitCalls)
    await expect(verifyAuthorization(args)).resolves.toBeDefined()
    expect(waitCalls).toHaveLength(1)
    expect(waitCalls[0]!.timeout).toBeUndefined()
    expect(waitCalls[0]).not.toHaveProperty('timeout')
  })
})

/* -------------------------------------------------------------------------- */
/*  transaction: settlementTimeoutMs → waitForTransactionReceipt timeout      */
/* -------------------------------------------------------------------------- */

describe('settlementTimeoutMs plumbing — verifyTransaction', () => {
  const CHALLENGE_ID = 'chal_knobs_tx'

  const ERC20_TRANSFER_ABI = [
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

  async function buildArgs(waitCalls: CapturedWaitArgs[], settlementTimeoutMs?: number) {
    const rawTx = await ACCOUNT.signTransaction({
      chainId: CHAIN_ID,
      to: CURRENCY,
      value: 0n,
      data: encodeFunctionData({
        abi: ERC20_TRANSFER_ABI,
        functionName: 'transfer',
        args: [RECIPIENT, BigInt(AMOUNT)],
      }),
      nonce: 0,
      type: 'eip1559',
      gas: 100_000n,
      maxFeePerGas: parseGwei('30'),
      maxPriorityFeePerGas: parseGwei('1'),
    })
    // Receipt carries the credential's own hash so the replacement-detection
    // branch (step 12.5) stays out of this test's way.
    const txHash = keccak256(rawTx)
    const receipt = buildReceipt({
      logs: [
        transferLog({ from: SIGNER, to: RECIPIENT, value: BigInt(AMOUNT), address: CURRENCY }),
      ],
      txHash,
    })
    const publicClient = {
      async sendRawTransaction() {
        return txHash
      },
      async waitForTransactionReceipt(args: CapturedWaitArgs) {
        waitCalls.push(args)
        return receipt
      },
    } as unknown as PublicClient
    const credential = {
      challenge: {
        id: CHALLENGE_ID,
        realm: REALM,
        method: 'evm',
        intent: 'charge',
        request: { amount: AMOUNT, currency: CURRENCY, recipient: RECIPIENT },
        expires: new Date(Date.now() + 60_000).toISOString(),
      },
      payload: { type: 'transaction', signature: rawTx },
    } as unknown as TransactionVerifierArgs['credential']
    const request: TransactionVerifierArgs['request'] = {
      amount: AMOUNT,
      currency: CURRENCY,
      recipient: RECIPIENT,
    }
    const ctx: TransactionVerifierCtx = {
      publicClient,
      store: freshStore(),
      chainId: CHAIN_ID,
      confirmations: 0,
      ...(settlementTimeoutMs !== undefined && { settlementTimeoutMs }),
    }
    return { credential, request, ctx }
  }

  test('set → waitForTransactionReceipt receives timeout === ctx.settlementTimeoutMs', async () => {
    const waitCalls: CapturedWaitArgs[] = []
    const args = await buildArgs(waitCalls, TIMEOUT_MS)
    await expect(verifyTransaction(args)).resolves.toBeDefined()
    expect(waitCalls).toHaveLength(1)
    expect(waitCalls[0]!.timeout).toBe(TIMEOUT_MS)
  })

  test('unset → timeout key is absent (viem default applies)', async () => {
    const waitCalls: CapturedWaitArgs[] = []
    const args = await buildArgs(waitCalls)
    await expect(verifyTransaction(args)).resolves.toBeDefined()
    expect(waitCalls).toHaveLength(1)
    expect(waitCalls[0]!.timeout).toBeUndefined()
    expect(waitCalls[0]).not.toHaveProperty('timeout')
  })
})

/* -------------------------------------------------------------------------- */
/*  hash: inflightTtlMs → reserve() reclaim age                               */
/* -------------------------------------------------------------------------- */

describe('inflightTtlMs plumbing — verifyHash', () => {
  const CHALLENGE_ID = 'chal_knobs_hash'
  const TX_HASH = `0x${'ab'.repeat(32)}` as const

  function buildArgs(store: ChargeStore, inflightTtlMs?: number) {
    const receipt = buildReceipt({
      logs: [
        transferLog({ from: SIGNER, to: RECIPIENT, value: BigInt(AMOUNT), address: CURRENCY }),
      ],
      txHash: TX_HASH,
    })
    const publicClient = {
      async getTransactionReceipt() {
        return receipt
      },
      async getBlockNumber() {
        return 100n
      },
    } as unknown as PublicClient
    const credential = {
      challenge: {
        id: CHALLENGE_ID,
        realm: REALM,
        method: 'evm',
        intent: 'charge',
        request: { amount: AMOUNT, currency: CURRENCY, recipient: RECIPIENT },
        expires: new Date(Date.now() + 60_000).toISOString(),
      },
      payload: { type: 'hash', hash: TX_HASH },
    } as unknown as HashVerifierArgs['credential']
    const request: HashVerifierArgs['request'] = {
      amount: AMOUNT,
      currency: CURRENCY,
      recipient: RECIPIENT,
    }
    const ctx: HashVerifierCtx = {
      publicClient,
      store,
      chainId: CHAIN_ID,
      confirmations: 0,
      hashFromPolicy: 'lax_from',
      ...(inflightTtlMs !== undefined && { inflightTtlMs }),
    }
    return { credential, request, ctx }
  }

  /** Seed an inflight slot whose ts is 5000ms in the past (wall clock). */
  async function seedStaleInflight(store: ChargeStore): Promise<void> {
    await store.update(txHashKey(CHAIN_ID, TX_HASH), () => ({
      op: 'set',
      value: { state: 'inflight' as const, ts: Date.now() - 5000 },
      result: true as const,
    }))
  }

  test('ctx.inflightTtlMs = 1000 → 5s-old inflight slot reclaimed, verify settles', async () => {
    const store = freshStore()
    await seedStaleInflight(store)

    const args = buildArgs(store, 1000)
    await expect(verifyHash(args)).resolves.toMatchObject({ status: 'success' })

    // The reclaimed slot ran the full pipeline to its terminal state.
    expect((await store.get(txHashKey(CHAIN_ID, TX_HASH)))?.state).toBe('consumed')
  })

  test('ctx.inflightTtlMs unset (10min default) → 5s-old slot still held, rejects concurrent', async () => {
    const store = freshStore()
    await seedStaleInflight(store)

    const args = buildArgs(store)
    await expect(verifyHash(args)).rejects.toThrow(
      /concurrent verify in progress for hash credential/,
    )

    // Slot untouched — still the seeded inflight.
    expect((await store.get(txHashKey(CHAIN_ID, TX_HASH)))?.state).toBe('inflight')
  })
})
