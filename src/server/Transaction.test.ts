/**
 * Transaction credential verifier unit tests (spec §8.3).
 *
 * Coverage matrix:
 *   - Local validation (steps 1-8): each rejection reason has its own case
 *     and never reserves a replay slot.
 *   - Replay pre-state (step 10): consumed / rejected / concurrent inflight
 *     terminate before broadcast.
 *   - Broadcast (step 11): clean broadcast + "already known with receipt"
 *     re-route + definitive rejection.
 *   - Receipt assertions (steps 13-14): reverted markRejected, log
 *     mismatch (from / to / amount) markRejected.
 *   - Happy path (step 15-16): markConsumed + buildEvmReceipt.
 */

import { Errors, Store } from 'mppx'
import {
  type Log,
  type PublicClient,
  type TransactionReceipt,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  keccak256,
  parseGwei,
  serializeTransaction,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test, vi } from 'vitest'

import {
  failOnState,
  terminalFailureStore,
} from '../../test/helpers/server/terminalFailureStore.js'
import { type ChargeStore, txKey } from './Replay.js'
import {
  type TransactionVerifierArgs,
  type TransactionVerifierCtx,
  verifyTransaction,
} from './Transaction.js'

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

const CHAIN_ID = 1
const CURRENCY = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const // USDC
const RECIPIENT = '0x2222222222222222222222222222222222222222' as const
const AMOUNT = '1000000'
const CHALLENGE_ID = 'chal_tx_test'
const CONFIRMATIONS = 0

const PK = '0x0202020202020202020202020202020202020202020202020202020202020202' as const
const ACCOUNT = privateKeyToAccount(PK)
const PAYER = ACCOUNT.address

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

function freshStore(): ChargeStore {
  return Store.memory() as unknown as ChargeStore
}

interface TxOverrides {
  chainId?: number
  to?: `0x${string}`
  value?: bigint
  transferTo?: `0x${string}`
  transferAmount?: bigint
  /** Force a non-transfer function (different selector). */
  rawData?: `0x${string}`
  /** Force a legacy / type-1 / type-3 tx instead of EIP-1559. */
  type?: 'legacy' | 'eip2930' | 'eip1559' | 'eip4844' | 'eip7702'
}

async function signERC20TransferTx(
  overrides: TxOverrides = {},
  account = ACCOUNT,
): Promise<`0x${string}`> {
  const data =
    overrides.rawData ??
    encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: 'transfer',
      args: [overrides.transferTo ?? RECIPIENT, overrides.transferAmount ?? BigInt(AMOUNT)],
    })
  const type = overrides.type ?? 'eip1559'
  // signTransaction works at the account level; serializeTransaction
  // would not include the signature. Use account.signTransaction.
  return account.signTransaction({
    chainId: overrides.chainId ?? CHAIN_ID,
    to: overrides.to ?? CURRENCY,
    value: overrides.value ?? 0n,
    data,
    nonce: 0,
    type: type as 'eip1559',
    gas: 100_000n,
    maxFeePerGas: parseGwei('30'),
    maxPriorityFeePerGas: parseGwei('1'),
  })
}

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

function buildReceipt(args: {
  status?: 'success' | 'reverted'
  blockNumber?: bigint
  logs?: Log[]
  txHash?: `0x${string}`
}): TransactionReceipt {
  const { status = 'success', blockNumber = 100n, logs = [], txHash = `0x${'c'.repeat(64)}` } = args
  return {
    blockHash: `0x${'d'.repeat(64)}` as `0x${string}`,
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
    transactionHash: txHash,
    transactionIndex: 0,
    type: 'eip1559',
  } as TransactionReceipt
}

interface StubClientConfig {
  sendError?: Error
  /** If true, getTransactionReceipt throws a real TransactionReceiptNotFoundError. */
  receiptNotFound?: boolean
  /** Arbitrary RPC error (timeout / 500 / etc) on getTransactionReceipt. */
  receiptRpcError?: Error
  /** Throw on getTransaction (mempool check) to simulate not-in-mempool. */
  mempoolNotFound?: boolean
  /** Arbitrary RPC error on getTransaction (mempool check). */
  mempoolRpcError?: Error
  receipt?: TransactionReceipt
}

function stubPublicClient(config: StubClientConfig = {}): PublicClient {
  return {
    async sendRawTransaction() {
      if (config.sendError) throw config.sendError
      return `0x${'e'.repeat(64)}`
    },
    async getTransactionReceipt({ hash }: { hash: `0x${string}` }) {
      // Throw the REAL viem class so the verifier's narrowed
      // `instanceof TransactionReceiptNotFoundError` check distinguishes
      // it from generic RPC errors. A custom Error subclass used to
      // pass the verifier's earlier bare `catch {}`; that branch is closed now.
      if (config.receiptRpcError) throw config.receiptRpcError
      if (config.receiptNotFound) throw new TransactionReceiptNotFoundError({ hash })
      return config.receipt ?? buildReceipt({})
    },
    async waitForTransactionReceipt() {
      return config.receipt ?? buildReceipt({})
    },
    async getTransaction({ hash }: { hash: `0x${string}` }) {
      if (config.mempoolRpcError) throw config.mempoolRpcError
      if (config.mempoolNotFound) throw new TransactionNotFoundError({ hash })
      return { hash: `0x${'f'.repeat(64)}`, blockNumber: null } as never
    },
  } as unknown as PublicClient
}

function buildCredential(
  overrides: { rawTx?: `0x${string}`; source?: string } = {},
): TransactionVerifierArgs['credential'] {
  return {
    challenge: {
      id: CHALLENGE_ID,
      realm: 'https://test.example/',
      method: 'evm',
      intent: 'charge',
      request: { amount: AMOUNT, currency: CURRENCY, recipient: RECIPIENT },
      expires: new Date(Date.now() + 60_000).toISOString(),
    },
    payload: {
      type: 'transaction',
      signature: overrides.rawTx ?? ('0xdeadbeef' as `0x${string}`),
    },
    ...(overrides.source !== undefined && { source: overrides.source }),
  } as unknown as TransactionVerifierArgs['credential']
}

const baseRequest: TransactionVerifierArgs['request'] = {
  amount: AMOUNT,
  currency: CURRENCY,
  recipient: RECIPIENT,
}

function buildCtx(
  overrides: Partial<TransactionVerifierCtx> & { publicClient: PublicClient },
): TransactionVerifierCtx {
  return {
    store: freshStore(),
    chainId: CHAIN_ID,
    confirmations: CONFIRMATIONS,
    ...overrides,
  }
}

/* -------------------------------------------------------------------------- */
/*  Happy path (steps 15-16)                                                  */
/* -------------------------------------------------------------------------- */

describe('verifyTransaction happy path', () => {
  test('returns receipt with txHash + markConsumed', async () => {
    const rawTx = await signERC20TransferTx()
    const expectedHash = keccak256(rawTx)
    const receipt = buildReceipt({
      txHash: expectedHash,
      logs: [transferLog({ from: PAYER, to: RECIPIENT, value: BigInt(AMOUNT), address: CURRENCY })],
    })
    const ctx = buildCtx({ publicClient: stubPublicClient({ receipt }) })

    const out = await verifyTransaction({
      credential: buildCredential({ rawTx }),
      request: baseRequest,
      ctx,
    })

    expect(out.reference).toBe(expectedHash)
    expect(out.method).toBe('evm')
    expect(out.status).toBe('success')
    expect(out.chainId).toBe(CHAIN_ID)
    expect(out.challengeId).toBe(CHALLENGE_ID)

    expect((await ctx.store.get(txKey(CHAIN_ID, expectedHash)))?.state).toBe('consumed')
  })

  test('echoes externalId when present', async () => {
    const rawTx = await signERC20TransferTx()
    const receipt = buildReceipt({
      txHash: keccak256(rawTx),
      logs: [transferLog({ from: PAYER, to: RECIPIENT, value: BigInt(AMOUNT), address: CURRENCY })],
    })
    const ctx = buildCtx({ publicClient: stubPublicClient({ receipt }) })

    const out = await verifyTransaction({
      credential: buildCredential({ rawTx }),
      request: { ...baseRequest, externalId: 'order-tx-1' },
      ctx,
    })
    expect(out.externalId).toBe('order-tx-1')
  })

  test('source matching recovered sender → success', async () => {
    const rawTx = await signERC20TransferTx()
    const receipt = buildReceipt({
      txHash: keccak256(rawTx),
      logs: [transferLog({ from: PAYER, to: RECIPIENT, value: BigInt(AMOUNT), address: CURRENCY })],
    })
    const ctx = buildCtx({ publicClient: stubPublicClient({ receipt }) })

    await expect(
      verifyTransaction({
        credential: buildCredential({ rawTx, source: `did:pkh:eip155:${CHAIN_ID}:${PAYER}` }),
        request: baseRequest,
        ctx,
      }),
    ).resolves.toBeDefined()
  })
})

/* -------------------------------------------------------------------------- */
/*  Local validation failures (steps 1-8)                                     */
/* -------------------------------------------------------------------------- */

describe('verifyTransaction local validation (no slot reservation)', () => {
  test('step 1: malformed RLP → throws parseTransaction', async () => {
    const ctx = buildCtx({ publicClient: stubPublicClient() })
    await expect(
      verifyTransaction({
        credential: buildCredential({ rawTx: '0xdeadbeef' }),
        request: baseRequest,
        ctx,
      }),
    ).rejects.toThrow(/parseTransaction failed/)
  })

  test('step 3: chainId mismatch', async () => {
    const rawTx = await signERC20TransferTx({ chainId: 137 }) // polygon, not ethereum
    const ctx = buildCtx({ publicClient: stubPublicClient() })
    await expect(
      verifyTransaction({
        credential: buildCredential({ rawTx }),
        request: baseRequest,
        ctx,
      }),
    ).rejects.toThrow(/chainId 137 != methodDetails.chainId 1/)
  })

  test('step 4: tx.to != currency', async () => {
    const rawTx = await signERC20TransferTx({
      to: '0x9999999999999999999999999999999999999999',
    })
    const ctx = buildCtx({ publicClient: stubPublicClient() })
    await expect(
      verifyTransaction({
        credential: buildCredential({ rawTx }),
        request: baseRequest,
        ctx,
      }),
    ).rejects.toThrow(/does not match currency/)
  })

  test('step 5: tx.value != 0', async () => {
    const rawTx = await signERC20TransferTx({ value: 1n })
    const ctx = buildCtx({ publicClient: stubPublicClient() })
    await expect(
      verifyTransaction({
        credential: buildCredential({ rawTx }),
        request: baseRequest,
        ctx,
      }),
    ).rejects.toThrow(/must be 0/)
  })

  test('step 6: tx.data does not start with transfer selector', async () => {
    const rawTx = await signERC20TransferTx({ rawData: '0xdeadbeef' })
    const ctx = buildCtx({ publicClient: stubPublicClient() })
    await expect(
      verifyTransaction({
        credential: buildCredential({ rawTx }),
        request: baseRequest,
        ctx,
      }),
    ).rejects.toThrow(/transfer\(\) selector/)
  })

  test('step 7: transfer recipient mismatch', async () => {
    const rawTx = await signERC20TransferTx({
      transferTo: '0x4444444444444444444444444444444444444444',
    })
    const ctx = buildCtx({ publicClient: stubPublicClient() })
    await expect(
      verifyTransaction({
        credential: buildCredential({ rawTx }),
        request: baseRequest,
        ctx,
      }),
    ).rejects.toThrow(/transfer recipient .* != request recipient/)
  })

  test('step 7: transfer amount mismatch', async () => {
    const rawTx = await signERC20TransferTx({ transferAmount: 999n })
    const ctx = buildCtx({ publicClient: stubPublicClient() })
    await expect(
      verifyTransaction({
        credential: buildCredential({ rawTx }),
        request: baseRequest,
        ctx,
      }),
    ).rejects.toThrow(/transfer amount .* != request amount/)
  })

  test('step 8: credential.source mismatch with recovered sender', async () => {
    const rawTx = await signERC20TransferTx()
    const ctx = buildCtx({ publicClient: stubPublicClient() })
    await expect(
      verifyTransaction({
        credential: buildCredential({
          rawTx,
          source: `did:pkh:eip155:${CHAIN_ID}:0x4444444444444444444444444444444444444444`,
        }),
        request: baseRequest,
        ctx,
      }),
    ).rejects.toThrow(/does not match recovered sender/)
  })

  test('step 8: credential.source with bad format', async () => {
    const rawTx = await signERC20TransferTx()
    const ctx = buildCtx({ publicClient: stubPublicClient() })
    await expect(
      verifyTransaction({
        credential: buildCredential({ rawTx, source: 'not-a-did' }),
        request: baseRequest,
        ctx,
      }),
    ).rejects.toThrow(/credential.source must match/)
  })
})

/* -------------------------------------------------------------------------- */
/*  Replay pre-state (step 10)                                                */
/* -------------------------------------------------------------------------- */

describe('verifyTransaction replay pre-state (step 10)', () => {
  test('already consumed → throws REPLAY', async () => {
    const rawTx = await signERC20TransferTx()
    const store = freshStore()
    await store.update(txKey(CHAIN_ID, keccak256(rawTx)), () => ({
      op: 'set',
      value: { state: 'consumed' as const, ts: Date.now() },
      result: true as const,
    }))
    const ctx = buildCtx({ store, publicClient: stubPublicClient() })

    await expect(
      verifyTransaction({
        credential: buildCredential({ rawTx }),
        request: baseRequest,
        ctx,
      }),
    ).rejects.toThrow(/already consumed/)
  })

  test('already rejected → throws REJECTED', async () => {
    const rawTx = await signERC20TransferTx()
    const store = freshStore()
    await store.update(txKey(CHAIN_ID, keccak256(rawTx)), () => ({
      op: 'set',
      value: { state: 'rejected' as const, ts: Date.now(), reason: 'previous revert' },
      result: true as const,
    }))
    const ctx = buildCtx({ store, publicClient: stubPublicClient() })

    await expect(
      verifyTransaction({
        credential: buildCredential({ rawTx }),
        request: baseRequest,
        ctx,
      }),
    ).rejects.toThrow(/previously rejected.*previous revert/)
  })

  test('concurrent inflight → throws CONCURRENT', async () => {
    const rawTx = await signERC20TransferTx()
    const store = freshStore()
    await store.update(txKey(CHAIN_ID, keccak256(rawTx)), () => ({
      op: 'set',
      value: { state: 'inflight' as const, ts: Date.now() },
      result: true as const,
    }))
    const ctx = buildCtx({ store, publicClient: stubPublicClient() })

    await expect(
      verifyTransaction({
        credential: buildCredential({ rawTx }),
        request: baseRequest,
        ctx,
      }),
    ).rejects.toThrow(/concurrent verify in progress/)
  })
})

/* -------------------------------------------------------------------------- */
/*  Broadcast error categorization (step 11)                                  */
/* -------------------------------------------------------------------------- */

describe('verifyTransaction broadcast error categorization (step 11)', () => {
  test('definite-rejected error → release + throw', async () => {
    const rawTx = await signERC20TransferTx()
    const ctx = buildCtx({
      publicClient: stubPublicClient({ sendError: new Error('invalid signature') }),
    })

    await expect(
      verifyTransaction({
        credential: buildCredential({ rawTx }),
        request: baseRequest,
        ctx,
      }),
    ).rejects.toThrow(/sendRawTransaction rejected.*invalid signature/)

    // Slot released for retry
    expect(await ctx.store.get(txKey(CHAIN_ID, keccak256(rawTx)))).toBeNull()
  })

  test('"already known" error + receipt exists → proceed to verify receipt', async () => {
    const rawTx = await signERC20TransferTx()
    const receipt = buildReceipt({
      txHash: keccak256(rawTx),
      logs: [transferLog({ from: PAYER, to: RECIPIENT, value: BigInt(AMOUNT), address: CURRENCY })],
    })
    const ctx = buildCtx({
      publicClient: stubPublicClient({
        sendError: new Error('already known'),
        receipt,
      }),
    })

    const out = await verifyTransaction({
      credential: buildCredential({ rawTx }),
      request: baseRequest,
      ctx,
    })
    expect(out.reference).toBe(keccak256(rawTx))
    expect((await ctx.store.get(txKey(CHAIN_ID, keccak256(rawTx))))?.state).toBe('consumed')
  })

  test('"nonce too low" + receipt missing + mempool missing → release + throw', async () => {
    const rawTx = await signERC20TransferTx()
    const ctx = buildCtx({
      publicClient: stubPublicClient({
        sendError: new Error('nonce too low'),
        receiptNotFound: true,
        mempoolNotFound: true,
      }),
    })

    await expect(
      verifyTransaction({
        credential: buildCredential({ rawTx }),
        request: baseRequest,
        ctx,
      }),
    ).rejects.toThrow(/not found in mempool/)

    expect(await ctx.store.get(txKey(CHAIN_ID, keccak256(rawTx)))).toBeNull()
  })

  test('"already known" + getTransactionReceipt RPC ERROR (not NotFound) → keep inflight + surface RPC error', async () => {
    // Previously the verifier's bare `catch {}` on getTransactionReceipt
    // treated any throw — including RPC timeouts / 429s / network drops
    // — as "no receipt yet → check mempool". The mempool branch might
    // succeed, fail, or also error, but the user never sees the actual
    // receipt-fetch problem. The catch now narrows to
    // TransactionReceiptNotFoundError; other errors fail fast with the
    // slot kept inflight.
    const rawTx = await signERC20TransferTx()
    const ctx = buildCtx({
      publicClient: stubPublicClient({
        sendError: new Error('already known'),
        receiptRpcError: new Error('ETIMEDOUT: RPC server unreachable'),
      }),
    })

    await expect(
      verifyTransaction({
        credential: buildCredential({ rawTx }),
        request: baseRequest,
        ctx,
      }),
    ).rejects.toThrow(/getTransactionReceipt RPC error after possibly-accepted send.*ETIMEDOUT/)

    // Slot remains inflight — we genuinely don't know whether the tx landed.
    const stored = await ctx.store.get(txKey(CHAIN_ID, keccak256(rawTx)))
    expect(stored?.state).toBe('inflight')
  })

  test('"already known" + receipt NotFound + getTransaction RPC ERROR → keep inflight + surface RPC error', async () => {
    // Same narrowing on the mempool-check path: only TransactionNotFoundError
    // means "definitively not in mempool → release". RPC errors keep
    // the slot inflight so a retry doesn't get a misleading "not in mempool".
    const rawTx = await signERC20TransferTx()
    const ctx = buildCtx({
      publicClient: stubPublicClient({
        sendError: new Error('already known'),
        receiptNotFound: true,
        mempoolRpcError: new Error('ETIMEDOUT: RPC mempool query failed'),
      }),
    })

    await expect(
      verifyTransaction({
        credential: buildCredential({ rawTx }),
        request: baseRequest,
        ctx,
      }),
    ).rejects.toThrow(/getTransaction RPC error after possibly-accepted send.*ETIMEDOUT/)

    const stored = await ctx.store.get(txKey(CHAIN_ID, keccak256(rawTx)))
    expect(stored?.state).toBe('inflight')
  })
})

/* -------------------------------------------------------------------------- */
/*  Receipt assertions (steps 13-14)                                          */
/* -------------------------------------------------------------------------- */

describe('verifyTransaction receipt assertions', () => {
  test('reverted tx → markRejected', async () => {
    const rawTx = await signERC20TransferTx()
    const receipt = buildReceipt({
      status: 'reverted',
      txHash: keccak256(rawTx),
    })
    const ctx = buildCtx({ publicClient: stubPublicClient({ receipt }) })

    await expect(
      verifyTransaction({
        credential: buildCredential({ rawTx }),
        request: baseRequest,
        ctx,
      }),
    ).rejects.toThrow(/reverted on-chain/)

    expect((await ctx.store.get(txKey(CHAIN_ID, keccak256(rawTx))))?.state).toBe('rejected')
  })

  test('Transfer log from != recoveredSender → markRejected', async () => {
    const rawTx = await signERC20TransferTx()
    const wrongSender = '0x9999999999999999999999999999999999999999' as const
    const receipt = buildReceipt({
      txHash: keccak256(rawTx),
      logs: [
        transferLog({ from: wrongSender, to: RECIPIENT, value: BigInt(AMOUNT), address: CURRENCY }),
      ],
    })
    const ctx = buildCtx({ publicClient: stubPublicClient({ receipt }) })

    await expect(
      verifyTransaction({
        credential: buildCredential({ rawTx }),
        request: baseRequest,
        ctx,
      }),
    ).rejects.toThrow(/no matching Transfer event/)

    expect((await ctx.store.get(txKey(CHAIN_ID, keccak256(rawTx))))?.state).toBe('rejected')
  })

  test('Transfer log amount mismatch → markRejected', async () => {
    const rawTx = await signERC20TransferTx()
    const receipt = buildReceipt({
      txHash: keccak256(rawTx),
      logs: [transferLog({ from: PAYER, to: RECIPIENT, value: 999n, address: CURRENCY })],
    })
    const ctx = buildCtx({ publicClient: stubPublicClient({ receipt }) })

    await expect(
      verifyTransaction({
        credential: buildCredential({ rawTx }),
        request: baseRequest,
        ctx,
      }),
    ).rejects.toThrow(/no matching Transfer event/)

    expect((await ctx.store.get(txKey(CHAIN_ID, keccak256(rawTx))))?.state).toBe('rejected')
  })
})

/* -------------------------------------------------------------------------- */
/*  Error class invariant                                                     */
/* -------------------------------------------------------------------------- */

describe('verifyTransaction error class invariant', () => {
  test('every failure throws Errors.VerificationFailedError', async () => {
    const ctx = buildCtx({ publicClient: stubPublicClient() })
    await expect(
      verifyTransaction({
        credential: buildCredential({ rawTx: '0xbad' }),
        request: baseRequest,
        ctx,
      }),
    ).rejects.toBeInstanceOf(Errors.VerificationFailedError)
  })
})

// Suppress unused-import lint warning for serializeTransaction (kept for
// potential future tests of unsigned-tx rejection branches).
void serializeTransaction

/* -------------------------------------------------------------------------- */
/*  Terminal-phase store-write failure must NOT release slot                   */
/* -------------------------------------------------------------------------- */

describe('verifyTransaction — terminal-phase store-write failure keeps slot inflight', () => {
  test('markConsumed throws → slot stays inflight (no release, no double-spend window)', async () => {
    // Models Redis transient outage right at the markConsumed CAS.
    // Previously the outer safety net would release() the slot → user could
    // resubmit the SAME signed RLP → broadcast as "already known" → if
    // the nonce-recovery flow released again the user might retry until
    // TTL, but more critically the SLOT being released means a different
    // observer of the same (chainId, txHash) wouldn't see "consumed" and
    // could mistakenly process the same tx as a fresh payment.
    const rawTx = await signERC20TransferTx()
    const expectedHash = keccak256(rawTx)
    const receipt = buildReceipt({
      txHash: expectedHash,
      logs: [transferLog({ from: PAYER, to: RECIPIENT, value: BigInt(AMOUNT), address: CURRENCY })],
    })
    const store = terminalFailureStore({
      failOn: failOnState('consumed'),
      message: 'ECONNRESET: Redis dropped right at markConsumed',
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const ctx = buildCtx({ store, publicClient: stubPublicClient({ receipt }) })

      await expect(
        verifyTransaction({
          credential: buildCredential({ rawTx }),
          request: baseRequest,
          ctx,
        }),
      ).rejects.toThrow(/ECONNRESET: Redis dropped right at markConsumed/)

      // CRITICAL: slot remains inflight. Releasing would re-admit the
      // same txHash for another verify cycle — the tx already mined, so
      // it would match again on retry → double-record the same payment.
      const slot = await store.get(txKey(CHAIN_ID, expectedHash))
      expect(slot?.state).toBe('inflight')

      // Operator visibility: warn fires so inflight isn't a silent leak.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/terminal-phase store write failed.*slot remains inflight/),
        expect.any(String),
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('markRejected throws on post-success log-mismatch → slot stays inflight (no release)', async () => {
    // The OTHER terminal branch for Transaction: waitForTransactionReceipt
    // returns successfully but the Transfer log doesn't match expectations
    // (e.g. a token's transfer() emits a Transfer with a different from-
    // address than the recovered tx sender — possible with proxy/forwarder
    // tokens). The user's nonce is burned by gas; verifier enters the
    // post-success markRejected path (Transaction.ts step 14). If
    // markRejected fails (Redis flaky right then), the
    // terminalPhase=true flag must STILL prevent the safety-net release —
    // otherwise a retry would re-broadcast (or "already known"), find
    // the same log mismatch, and re-attempt markRejected.
    const wrongFrom = '0x7777777777777777777777777777777777777777' as const
    const rawTx = await signERC20TransferTx()
    const expectedHash = keccak256(rawTx)
    const receipt = buildReceipt({
      txHash: expectedHash,
      logs: [
        transferLog({ from: wrongFrom, to: RECIPIENT, value: BigInt(AMOUNT), address: CURRENCY }),
      ],
    })
    const store = terminalFailureStore({
      failOn: failOnState('rejected'),
      message: 'ECONNRESET: Redis dropped right at markRejected',
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const ctx = buildCtx({ store, publicClient: stubPublicClient({ receipt }) })

      await expect(
        verifyTransaction({
          credential: buildCredential({ rawTx }),
          request: baseRequest,
          ctx,
        }),
      ).rejects.toThrow(/ECONNRESET: Redis dropped right at markRejected/)

      const slot = await store.get(txKey(CHAIN_ID, expectedHash))
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
