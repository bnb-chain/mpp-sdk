/**
 * Core settlement adapter — `LocalSignerAdapter` (simulate→write→wait).
 *
 *   - success → SettleReceipt with a `logs` proof (verifier matches the Transfer);
 *   - wait timeout → SettlePendingError (slot stays inflight);
 *   - on-chain revert → status 'reverted'.
 *
 * The facilitator adapter (`B402Adapter`) and its end-to-end verify path live in
 * `src/b402/mppx/Adapter.test.ts` — core keeps zero b402 import.
 */

import { type Log, type PublicClient, type TransactionReceipt, type WalletClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vitest'

import { eip3009Domain, eip3009Nonce, eip3009Types } from '../protocol/TypedData.js'
import { type Eip3009Settlement, LocalSignerAdapter, SettlePendingError } from './Settle.js'

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

const CHAIN_ID = 1
const CURRENCY = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const // USDC
const RECIPIENT = '0x2222222222222222222222222222222222222222' as const
const AMOUNT = '1000000'
const REALM = 'https://test.example/'
const TOKEN_NAME = 'USD Coin'
const TOKEN_VERSION = '2'

const ACCOUNT = privateKeyToAccount(
  '0x0505050505050505050505050505050505050505050505050505050505050505',
)
const SETTLEMENT_ACCOUNT = privateKeyToAccount(
  '0x0606060606060606060606060606060606060606060606060606060606060606',
)
const CHALLENGE_ID = 'chal_settle_test'
const NONCE = eip3009Nonce(CHALLENGE_ID, REALM)
const NOW = Math.floor(Date.now() / 1000)

async function signEip3009(): Promise<`0x${string}`> {
  return ACCOUNT.signTypedData({
    domain: eip3009Domain({
      tokenName: TOKEN_NAME,
      tokenVersion: TOKEN_VERSION,
      chainId: CHAIN_ID,
      tokenAddress: CURRENCY,
    }),
    types: eip3009Types,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: ACCOUNT.address,
      to: RECIPIENT,
      value: BigInt(AMOUNT),
      validAfter: BigInt(NOW - 60),
      validBefore: BigInt(NOW + 600),
      nonce: NONCE,
    },
  })
}

async function settlement(): Promise<Eip3009Settlement> {
  return {
    token: CURRENCY,
    chainId: CHAIN_ID,
    from: ACCOUNT.address,
    to: RECIPIENT,
    value: BigInt(AMOUNT),
    validAfter: BigInt(NOW - 60),
    validBefore: BigInt(NOW + 600),
    nonce: NONCE,
    signature: await signEip3009(),
    eip712: { name: TOKEN_NAME, version: TOKEN_VERSION },
  }
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

function stubPublicClient(receiptOrError: TransactionReceipt | Error): PublicClient {
  return {
    async simulateContract() {
      return { result: undefined, request: {} }
    },
    async waitForTransactionReceipt() {
      if (receiptOrError instanceof Error) throw receiptOrError
      return receiptOrError
    },
  } as unknown as PublicClient
}

function receipt(status: 'success' | 'reverted'): TransactionReceipt {
  return {
    status,
    transactionHash: `0x${'d'.repeat(64)}`,
    logs: [] as Log[],
    blockNumber: 100n,
  } as unknown as TransactionReceipt
}

/* ── LocalSignerAdapter ───────────────────────────────────────────────────── */

describe('LocalSignerAdapter', () => {
  test('success → SettleReceipt with a logs proof + the broadcast tx', async () => {
    const adapter = new LocalSignerAdapter(stubWalletClient())
    const out = await adapter.settleAuthorization(await settlement(), {
      publicClient: stubPublicClient(receipt('success')),
      confirmations: 1,
    })
    expect(out.status).toBe('success')
    expect(out.proof.kind).toBe('logs')
    expect(out.transactionHash).toMatch(/^0x[0-9a-f]{64}$/)
  })

  test('on-chain revert → status "reverted"', async () => {
    const adapter = new LocalSignerAdapter(stubWalletClient())
    const out = await adapter.settleAuthorization(await settlement(), {
      publicClient: stubPublicClient(receipt('reverted')),
      confirmations: 1,
    })
    expect(out.status).toBe('reverted')
  })

  test('receipt-wait timeout → SettlePendingError', async () => {
    const adapter = new LocalSignerAdapter(stubWalletClient())
    await expect(
      adapter.settleAuthorization(await settlement(), {
        publicClient: stubPublicClient(new Error('timed out')),
        confirmations: 1,
      }),
    ).rejects.toBeInstanceOf(SettlePendingError)
  })
})
