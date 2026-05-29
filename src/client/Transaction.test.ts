/**
 * createTransactionCredential — unit + round-trip through server verifier.
 */

import { Credential } from 'mppx'
import { Mppx } from 'mppx/server'
import {
  type Log,
  type PublicClient,
  type TransactionReceipt,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  parseGwei,
  parseTransaction,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vitest'

import { preflightChargeForTest } from '../../test/helpers/server/preflightChargeForTest.js'
import { charge } from '../server/Charge.js'
import { createTransactionCredential } from './Transaction.js'

const SECRET = 'tx-client-test-secret' as const
const CHAIN_ID = 1
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const
// PERMIT2 fixture no longer needed at the route layer —
// server defaults inject methodDetails.permit2Address.
const RECIPIENT = '0x2222222222222222222222222222222222222222' as const
const AMOUNT = '1000000'

const PK = '0x0707070707070707070707070707070707070707070707070707070707070707' as const
const ACCOUNT = privateKeyToAccount(PK)

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

function buildSuccessReceipt(rawTx: `0x${string}`): TransactionReceipt {
  const txHash = keccak256(rawTx) as `0x${string}`
  const transferLog: Log = {
    address: USDC,
    blockHash: `0x${'a'.repeat(64)}` as `0x${string}`,
    blockNumber: 100n,
    data: encodeAbiParameters([{ type: 'uint256' }], [BigInt(AMOUNT)]),
    logIndex: 0,
    removed: false,
    topics: encodeEventTopics({
      abi: TRANSFER_ABI,
      eventName: 'Transfer',
      args: { from: ACCOUNT.address, to: RECIPIENT },
    }) as Log['topics'],
    transactionHash: txHash,
    transactionIndex: 0,
  } as Log
  return {
    blockHash: `0x${'b'.repeat(64)}` as `0x${string}`,
    blockNumber: 100n,
    contractAddress: null,
    cumulativeGasUsed: 0n,
    effectiveGasPrice: 0n,
    from: ACCOUNT.address,
    gasUsed: 0n,
    logs: [transferLog],
    logsBloom: '0x' as `0x${string}`,
    status: 'success',
    to: USDC,
    transactionHash: txHash,
    transactionIndex: 0,
    type: 'eip1559',
  } as TransactionReceipt
}

function txClient(rawTxHolder: { rawTx?: `0x${string}` | undefined }): PublicClient {
  return {
    async sendRawTransaction() {
      return rawTxHolder.rawTx
        ? (keccak256(rawTxHolder.rawTx) as `0x${string}`)
        : `0x${'c'.repeat(64)}`
    },
    async getTransactionReceipt() {
      if (!rawTxHolder.rawTx) throw new Error('rawTx not set in test holder')
      return buildSuccessReceipt(rawTxHolder.rawTx)
    },
    async waitForTransactionReceipt() {
      if (!rawTxHolder.rawTx) throw new Error('rawTx not set in test holder')
      return buildSuccessReceipt(rawTxHolder.rawTx)
    },
    async getBlockNumber() {
      return 200n
    },
    async getTransaction() {
      return { hash: `0x${'d'.repeat(64)}`, blockNumber: null } as never
    },
  } as unknown as PublicClient
}

async function buildHandlerWithStub(rawTxHolder: { rawTx?: `0x${string}` | undefined }) {
  const prepared = await preflightChargeForTest(
    {
      chain: 'ethereum',
      token: 'USDC',
      recipient: RECIPIENT,
      credentialTypes: ['transaction'],
      challengeBinding: { mode: 'mppx-managed' },
    },
    { mockedIsContractDeployed: () => true, publicClient: txClient(rawTxHolder) },
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

describe('createTransactionCredential — unit', () => {
  test('produces a payload with type=transaction + parsable EIP-1559 signature', async () => {
    const rawHolder = { rawTx: undefined as `0x${string}` | undefined }
    const handler = await buildHandlerWithStub(rawHolder)
    const challenge = await handler.challenge.evm.charge(fullRequest)

    const serialized = await createTransactionCredential({
      challenge,
      account: ACCOUNT,
      chainId: CHAIN_ID,
      currency: USDC,
      recipient: RECIPIENT,
      amount: AMOUNT,
      nonce: 0,
      maxFeePerGas: parseGwei('30'),
      maxPriorityFeePerGas: parseGwei('1'),
    })
    const parsed = Credential.deserialize(serialized)
    expect((parsed.payload as { type: string }).type).toBe('transaction')

    const rawTx = (parsed.payload as { signature: `0x${string}` }).signature
    expect(rawTx.startsWith('0x02')).toBe(true) // EIP-1559 type tag

    // Locally re-parse to confirm wire content matches what we asked for.
    const tx = parseTransaction(rawTx)
    expect(tx.type).toBe('eip1559')
    expect(tx.chainId).toBe(CHAIN_ID)
    expect(tx.to?.toLowerCase()).toBe(USDC)
  })
})

/* -------------------------------------------------------------------------- */
/*  Round-trip via server verifier                                            */
/* -------------------------------------------------------------------------- */

describe('createTransactionCredential — round-trip with server verifier', () => {
  test('handler.verifyCredential accepts client-built transaction credential', async () => {
    const rawHolder = { rawTx: undefined as `0x${string}` | undefined }
    const handler = await buildHandlerWithStub(rawHolder)
    const challenge = await handler.challenge.evm.charge(fullRequest)

    const serialized = await createTransactionCredential({
      challenge,
      account: ACCOUNT,
      chainId: CHAIN_ID,
      currency: USDC,
      recipient: RECIPIENT,
      amount: AMOUNT,
      nonce: 0,
      maxFeePerGas: parseGwei('30'),
      maxPriorityFeePerGas: parseGwei('1'),
    })

    // Extract rawTx so the stub publicClient returns the right receipt
    // (keyed by keccak256(rawTx)).
    const cred = Credential.deserialize(serialized)
    rawHolder.rawTx = (cred.payload as { signature: `0x${string}` }).signature

    const receipt = await handler.verifyCredential(serialized, { request: fullRequest })
    expect(receipt).toMatchObject({
      method: 'evm',
      status: 'success',
      reference: keccak256(rawHolder.rawTx!),
      challengeId: challenge.id,
      chainId: CHAIN_ID,
    })
  })
})
