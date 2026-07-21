/**
 * createPermit2Credential — unit + round-trip through server verifier.
 *
 * Tests both single-permit (no splits) and batch-permit (splits) paths.
 */

import { Credential } from 'mppx'
import { Mppx } from 'mppx/server'
import {
  type Log,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
  encodeAbiParameters,
  encodeEventTopics,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vitest'

import { preflightChargeForTest } from '../../test/helpers/server/preflightChargeForTest.js'
import { charge } from '../server/Charge.js'
import { createPermit2Credential } from './Permit2.js'

const SECRET = 'permit2-client-test-secret-at-least-32-bytes' as const
const CHAIN_ID = 1
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3' as const
const RECIPIENT = '0x2222222222222222222222222222222222222222' as const
const SPLIT_RECIPIENT = '0x3333333333333333333333333333333333333333' as const
const AMOUNT = '1000000'
const SPLIT = '100000'
const NONCE = '12345'

const PK = '0x0808080808080808080808080808080808080808080808080808080808080808' as const
const ACCOUNT = privateKeyToAccount(PK)

const SETTLEMENT_PK = '0x0909090909090909090909090909090909090909090909090909090909090909' as const
const SETTLEMENT = privateKeyToAccount(SETTLEMENT_PK)

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

function transferLog(args: { to: `0x${string}`; value: bigint; index?: number }): Log {
  const { to, value, index = 0 } = args
  return {
    address: USDC,
    blockHash: `0x${'a'.repeat(64)}` as `0x${string}`,
    blockNumber: 100n,
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
    logIndex: index,
    removed: false,
    topics: encodeEventTopics({
      abi: TRANSFER_ABI,
      eventName: 'Transfer',
      args: { from: ACCOUNT.address, to },
    }) as Log['topics'],
    transactionHash: `0x${'b'.repeat(64)}` as `0x${string}`,
    transactionIndex: 0,
  } as Log
}

function happyReceipt(logs: Log[]): TransactionReceipt {
  return {
    blockHash: `0x${'c'.repeat(64)}` as `0x${string}`,
    blockNumber: 100n,
    contractAddress: null,
    cumulativeGasUsed: 0n,
    effectiveGasPrice: 0n,
    from: SETTLEMENT.address,
    gasUsed: 0n,
    logs,
    logsBloom: '0x' as `0x${string}`,
    status: 'success',
    to: PERMIT2,
    transactionHash: `0x${'d'.repeat(64)}` as `0x${string}`,
    transactionIndex: 0,
    type: 'eip1559',
  } as TransactionReceipt
}

function makePublicClient(receipt: TransactionReceipt): PublicClient {
  return {
    async readContract({ functionName }: { functionName: string }) {
      if (functionName === 'balanceOf') return BigInt(AMOUNT) * 100n
      if (functionName === 'allowance') return BigInt(AMOUNT) * 100n
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

function makeWalletClient(): WalletClient {
  return {
    account: SETTLEMENT,
    chain: null,
    async writeContract() {
      return `0x${'e'.repeat(64)}` as `0x${string}`
    },
  } as unknown as WalletClient
}

async function buildHandler(
  receipt: TransactionReceipt,
  opts: {
    splits?: ReadonlyArray<{ recipient: `0x${string}`; amount: string; memo?: string }>
  } = {},
) {
  const prepared = await preflightChargeForTest(
    {
      chain: 'ethereum',
      token: 'USDC',
      recipient: RECIPIENT,
      credentialTypes: ['permit2'],
      settlementAccount: SETTLEMENT,
      challengeBinding: { mode: 'mppx-managed' },
      // Splits are protected (spec §10 / §14.10) — they must be configured
      // at the server-factory level, not passed at route level. The route
      // override guard would reject any per-call splits[] otherwise.
      ...(opts.splits && { splits: [...opts.splits] }),
    },
    {
      mockedIsContractDeployed: () => true,
      publicClient: makePublicClient(receipt),
    },
  )
  // Replace the resolved settlementSigner with our stub (preflight builds
  // a real walletClient from the account; we override for tests).
  const stubbed = {
    ...prepared,
    _resolved: { ...prepared._resolved, settlementSigner: makeWalletClient() },
  }
  return Mppx.create({ methods: [charge(stubbed)], secretKey: SECRET })
}

// Route options should carry ONLY the per-call fields (amount /
// description / externalId). Everything else — currency, recipient, the
// full methodDetails — comes from server factory defaults. Passing
// partial methodDetails would silently drop credentialTypes / decimals
// from the issued challenge (mppx merges shallowly), which the
// request-hook guard now rejects with an explicit "partial methodDetails"
// error. The Permit2 caller's only required route input is amount.
const fullRequest = { amount: AMOUNT } as const

/* -------------------------------------------------------------------------- */
/*  Unit                                                                      */
/* -------------------------------------------------------------------------- */

describe('createPermit2Credential — unit', () => {
  test('single-permit output shape (no splits)', async () => {
    const receipt = happyReceipt([transferLog({ to: RECIPIENT, value: BigInt(AMOUNT) })])
    const handler = await buildHandler(receipt)
    const challenge = await handler.challenge.evm.charge(fullRequest)

    const serialized = await createPermit2Credential({
      challenge,
      account: ACCOUNT,
      chainId: CHAIN_ID,
      permit2Address: PERMIT2,
      currency: USDC,
      recipient: RECIPIENT,
      amount: AMOUNT,
      nonce: NONCE,
      deadline: String(Math.floor(Date.now() / 1000) + 600),
    })
    const parsed = Credential.deserialize(serialized)
    const payload = parsed.payload as {
      type: string
      permit: { permitted: { token: string; amount: string }[]; nonce: string; deadline: string }
      transferDetails: { to: string; requestedAmount: string }[]
      witness: { challengeHash: string; externalId: string }
      signature: string
    }
    expect(payload.type).toBe('permit2')
    expect(payload.permit.permitted).toHaveLength(1)
    expect(payload.permit.permitted[0]!.token.toLowerCase()).toBe(USDC)
    expect(payload.permit.permitted[0]!.amount).toBe(AMOUNT)
    expect(payload.transferDetails).toHaveLength(1)
    expect(payload.transferDetails[0]!.to.toLowerCase()).toBe(RECIPIENT)
    expect(payload.transferDetails[0]!.requestedAmount).toBe(AMOUNT)
    expect(payload.witness.externalId).toBe('')
    expect(parsed.source).toBe(`did:pkh:eip155:${CHAIN_ID}:${ACCOUNT.address}`)
  })

  test('copies challenge.request.externalId into PaymentWitness', async () => {
    const receipt = happyReceipt([transferLog({ to: RECIPIENT, value: BigInt(AMOUNT) })])
    const handler = await buildHandler(receipt)
    const challenge = await handler.challenge.evm.charge({ amount: AMOUNT, externalId: 'order-42' })

    const serialized = await createPermit2Credential({
      challenge,
      account: ACCOUNT,
      chainId: CHAIN_ID,
      permit2Address: PERMIT2,
      currency: USDC,
      recipient: RECIPIENT,
      amount: AMOUNT,
      nonce: NONCE,
      deadline: String(Math.floor(Date.now() / 1000) + 600),
    })
    const payload = Credential.deserialize(serialized).payload as {
      witness: { externalId: string }
    }
    expect(payload.witness.externalId).toBe('order-42')
  })

  test('batch-permit output shape (with splits)', async () => {
    const primaryAmount = String(BigInt(AMOUNT) - BigInt(SPLIT))
    const receipt = happyReceipt([
      transferLog({ to: RECIPIENT, value: BigInt(primaryAmount), index: 0 }),
      transferLog({ to: SPLIT_RECIPIENT, value: BigInt(SPLIT), index: 1 }),
    ])
    const handler = await buildHandler(receipt, {
      splits: [{ recipient: SPLIT_RECIPIENT, amount: SPLIT }],
    })
    // Splits live in server defaults (configured in
    // buildHandler) — the route MUST stay minimal {amount}; the challenge
    // mppx issues will pick up `methodDetails.splits` from defaults.
    // Likewise the client's createPermit2Credential may omit opts.splits
    // entirely and the SDK will read them from the issued challenge.
    const challenge = await handler.challenge.evm.charge(fullRequest)

    const serialized = await createPermit2Credential({
      challenge,
      account: ACCOUNT,
      chainId: CHAIN_ID,
      permit2Address: PERMIT2,
      currency: USDC,
      recipient: RECIPIENT,
      amount: AMOUNT,
      nonce: NONCE,
      deadline: String(Math.floor(Date.now() / 1000) + 600),
      // splits omitted intentionally — challenge is the source
      // of truth; SDK reads splits from challenge.request.methodDetails.splits.
    })
    const parsed = Credential.deserialize(serialized)
    const payload = parsed.payload as {
      permit: { permitted: { amount: string }[] }
      transferDetails: { to: string; requestedAmount: string }[]
    }
    expect(payload.permit.permitted).toHaveLength(2)
    expect(payload.transferDetails).toHaveLength(2)
    expect(payload.transferDetails[0]!.requestedAmount).toBe(primaryAmount)
    expect(payload.transferDetails[1]!.requestedAmount).toBe(SPLIT)
    expect(payload.transferDetails[1]!.to.toLowerCase()).toBe(SPLIT_RECIPIENT)
  })

  test('explicit opts.splits with `memo` deep-equals challenge wire memo', async () => {
    // Previously the `Permit2Split` type omitted `memo`, so a caller could
    // only satisfy resolvePermit2Splits' memo-aware deep-equal by
    // OMITTING opts.splits entirely (letting the SDK read from the
    // challenge). Explicit opts.splits with memo was structurally
    // impossible to express in the public type. Adding
    // `readonly memo?: string` to Permit2Split lets callers pass
    // through the full split shape when they want explicit control.
    const SPLIT_MEMO = 'split-revenue-share' as const
    const primaryAmount = String(BigInt(AMOUNT) - BigInt(SPLIT))
    const receipt = happyReceipt([
      transferLog({ to: RECIPIENT, value: BigInt(primaryAmount), index: 0 }),
      transferLog({ to: SPLIT_RECIPIENT, value: BigInt(SPLIT), index: 1 }),
    ])
    const handler = await buildHandler(receipt, {
      splits: [{ recipient: SPLIT_RECIPIENT, amount: SPLIT, memo: SPLIT_MEMO }],
    })
    const challenge = await handler.challenge.evm.charge(fullRequest)

    const serialized = await createPermit2Credential({
      challenge,
      account: ACCOUNT,
      chainId: CHAIN_ID,
      permit2Address: PERMIT2,
      currency: USDC,
      recipient: RECIPIENT,
      amount: AMOUNT,
      nonce: NONCE,
      deadline: String(Math.floor(Date.now() / 1000) + 600),
      // Explicit splits with memo. resolvePermit2Splits does
      // a structural deep-equal that includes memo; a mismatch (or the
      // typed-as-absent old behavior) would throw.
      splits: [{ recipient: SPLIT_RECIPIENT, amount: SPLIT, memo: SPLIT_MEMO }],
    })

    const parsed = Credential.deserialize(serialized)
    expect(parsed.payload).toMatchObject({ type: 'permit2' })
  })
})

/* -------------------------------------------------------------------------- */
/*  Round-trip via server verifier                                            */
/* -------------------------------------------------------------------------- */

describe('createPermit2Credential — round-trip with server verifier', () => {
  test('single-permit handler.verifyCredential round-trip', async () => {
    const receipt = happyReceipt([transferLog({ to: RECIPIENT, value: BigInt(AMOUNT) })])
    const handler = await buildHandler(receipt)
    const request = { amount: AMOUNT, externalId: 'order-roundtrip' } as const
    const challenge = await handler.challenge.evm.charge(request)

    const serialized = await createPermit2Credential({
      challenge,
      account: ACCOUNT,
      chainId: CHAIN_ID,
      permit2Address: PERMIT2,
      currency: USDC,
      recipient: RECIPIENT,
      amount: AMOUNT,
      nonce: NONCE,
      deadline: String(Math.floor(Date.now() / 1000) + 600),
    })

    const out = await handler.verifyCredential(serialized, { request })
    expect(out).toMatchObject({
      method: 'evm',
      status: 'success',
      challengeId: challenge.id,
      chainId: CHAIN_ID,
      externalId: 'order-roundtrip',
    })
  })

  test('batch-permit handler.verifyCredential round-trip (with splits)', async () => {
    const primaryAmount = String(BigInt(AMOUNT) - BigInt(SPLIT))
    const receipt = happyReceipt([
      transferLog({ to: RECIPIENT, value: BigInt(primaryAmount), index: 0 }),
      transferLog({ to: SPLIT_RECIPIENT, value: BigInt(SPLIT), index: 1 }),
    ])
    const handler = await buildHandler(receipt, {
      splits: [{ recipient: SPLIT_RECIPIENT, amount: SPLIT }],
    })
    // Route stays minimal — splits come from server
    // defaults (configured in buildHandler) on both issue + verify paths.
    const challenge = await handler.challenge.evm.charge(fullRequest)

    const serialized = await createPermit2Credential({
      challenge,
      account: ACCOUNT,
      chainId: CHAIN_ID,
      permit2Address: PERMIT2,
      currency: USDC,
      recipient: RECIPIENT,
      amount: AMOUNT,
      nonce: NONCE,
      deadline: String(Math.floor(Date.now() / 1000) + 600),
      // splits omitted intentionally — challenge is the source of truth.
    })

    const out = await handler.verifyCredential(serialized, { request: fullRequest })
    expect(out).toMatchObject({
      method: 'evm',
      status: 'success',
      challengeId: challenge.id,
    })
  })
})
