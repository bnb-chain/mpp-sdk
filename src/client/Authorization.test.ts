/**
 * createAuthorizationCredential — unit + round-trip through server verifier.
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
import { describe, expect, test, vi } from 'vitest'

import { preflightChargeForTest } from '../../test/helpers/server/preflightChargeForTest.js'
import { eip3009Nonce } from '../protocol/TypedData.js'
import { charge } from '../server/Charge.js'
import { createAuthorizationCredential } from './Authorization.js'

const SECRET = 'auth-client-test-secret' as const
const CHAIN_ID = 1
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const
// PERMIT2 fixture no longer needed at the route layer —
// server defaults inject methodDetails.permit2Address.
const RECIPIENT = '0x2222222222222222222222222222222222222222' as const
const AMOUNT = '1000000'

const PK = '0x0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a' as const
const ACCOUNT = privateKeyToAccount(PK)

const SETTLEMENT_PK = '0x0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b' as const
const SETTLEMENT = privateKeyToAccount(SETTLEMENT_PK)

const EIP712 = { name: 'USD Coin', version: '2' }

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

function transferLog(): Log {
  return {
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
    transactionHash: `0x${'b'.repeat(64)}` as `0x${string}`,
    transactionIndex: 0,
  } as Log
}

function happyReceipt(): TransactionReceipt {
  return {
    blockHash: `0x${'c'.repeat(64)}` as `0x${string}`,
    blockNumber: 100n,
    contractAddress: null,
    cumulativeGasUsed: 0n,
    effectiveGasPrice: 0n,
    from: SETTLEMENT.address,
    gasUsed: 0n,
    logs: [transferLog()],
    logsBloom: '0x' as `0x${string}`,
    status: 'success',
    to: USDC,
    transactionHash: `0x${'d'.repeat(64)}` as `0x${string}`,
    transactionIndex: 0,
    type: 'eip1559',
  } as TransactionReceipt
}

function makePublicClient(): PublicClient {
  return {
    async readContract({ functionName }: { functionName: string }) {
      if (functionName === 'balanceOf') return BigInt(AMOUNT) * 100n
      throw new Error(`unexpected readContract: ${functionName}`)
    },
    async simulateContract() {
      return { result: undefined, request: {} }
    },
    async waitForTransactionReceipt() {
      return happyReceipt()
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

async function buildHandler() {
  const prepared = await preflightChargeForTest(
    {
      chain: 'ethereum',
      token: 'USDC',
      recipient: RECIPIENT,
      credentialTypes: ['authorization'],
      settlementAccount: SETTLEMENT,
      challengeBinding: { mode: 'mppx-managed' },
    },
    {
      mockedIsContractDeployed: () => true,
      publicClient: makePublicClient(),
    },
  )
  const stubbed = {
    ...prepared,
    _resolved: { ...prepared._resolved, settlementSigner: makeWalletClient() },
  }
  return Mppx.create({ methods: [charge(stubbed)], secretKey: SECRET })
}

// Route options should carry ONLY per-call fields (amount /
// description / externalId). Server factory defaults inject the full
// methodDetails (chainId, permit2Address, credentialTypes, decimals).
// Passing partial methodDetails at the route level would silently
// drop credentialTypes from the issued challenge (mppx merges shallowly),
// and the client accepted-types check would then correctly
// reject the resulting authorization credential.
const fullRequest = { amount: AMOUNT } as const

/* -------------------------------------------------------------------------- */
/*  Unit                                                                      */
/* -------------------------------------------------------------------------- */

describe('createAuthorizationCredential — unit', () => {
  test('payload shape: type / from / to / value / nonce / signature', async () => {
    const handler = await buildHandler()
    const challenge = await handler.challenge.evm.charge(fullRequest)

    const serialized = await createAuthorizationCredential({
      challenge,
      account: ACCOUNT,
      chainId: CHAIN_ID,
      currency: USDC,
      recipient: RECIPIENT,
      amount: AMOUNT,
      eip712: EIP712,
    })
    const parsed = Credential.deserialize(serialized)
    const payload = parsed.payload as {
      type: string
      from: string
      to: string
      value: string
      nonce: string
      signature: string
    }
    expect(payload.type).toBe('authorization')
    expect(payload.from.toLowerCase()).toBe(ACCOUNT.address.toLowerCase())
    expect(payload.to.toLowerCase()).toBe(RECIPIENT)
    expect(payload.value).toBe(AMOUNT)
    // Nonce derives from challenge — must equal eip3009Nonce(challenge.id, realm)
    expect(payload.nonce).toBe(eip3009Nonce(challenge.id, challenge.realm))
    expect(payload.signature).toMatch(/^0x[0-9a-fA-F]{130}$/) // 65-byte sig
  })

  test('default validAfter / validBefore window straddles now', async () => {
    const handler = await buildHandler()
    const challenge = await handler.challenge.evm.charge(fullRequest)

    const serialized = await createAuthorizationCredential({
      challenge,
      account: ACCOUNT,
      chainId: CHAIN_ID,
      currency: USDC,
      recipient: RECIPIENT,
      amount: AMOUNT,
      eip712: EIP712,
    })
    const parsed = Credential.deserialize(serialized)
    const payload = parsed.payload as { validAfter: string; validBefore: string }
    const now = Math.floor(Date.now() / 1000)
    expect(Number(payload.validAfter)).toBeLessThanOrEqual(now)
    expect(Number(payload.validBefore)).toBeGreaterThan(now)
  })
})

/* -------------------------------------------------------------------------- */
/*  validBefore defaults (spec §5.3.2 SHOULD) + pre-sign window guard          */
/* -------------------------------------------------------------------------- */

describe('createAuthorizationCredential — validBefore defaults (spec §5.3.2)', () => {
  test('default validBefore equals challenge.expires (in seconds) when expires < now+600', async () => {
    const handler = await buildHandler()
    const base = await handler.challenge.evm.charge(fullRequest)
    // expires 2min out — sooner than the now+600 cap, so the default
    // validBefore must bind EXACTLY to the expires timestamp.
    const expiresMs = Date.now() + 120_000
    const challenge = { ...base, expires: new Date(expiresMs).toISOString() }

    const serialized = await createAuthorizationCredential({
      challenge,
      account: ACCOUNT,
      chainId: CHAIN_ID,
      currency: USDC,
      recipient: RECIPIENT,
      amount: AMOUNT,
      eip712: EIP712,
    })
    const payload = Credential.deserialize(serialized).payload as { validBefore: string }
    expect(payload.validBefore).toBe(String(Math.floor(expiresMs / 1000)))
  })

  test('default validBefore equals now+600 when challenge has no expires', async () => {
    const handler = await buildHandler()
    const base = await handler.challenge.evm.charge(fullRequest)
    // mppx Challenge schema marks expires OPTIONAL — drop it entirely.
    const { expires: _expires, ...challenge } = base
    expect(challenge).not.toHaveProperty('expires')

    const before = Math.floor(Date.now() / 1000)
    const serialized = await createAuthorizationCredential({
      challenge,
      account: ACCOUNT,
      chainId: CHAIN_ID,
      currency: USDC,
      recipient: RECIPIENT,
      amount: AMOUNT,
      eip712: EIP712,
    })
    const after = Math.floor(Date.now() / 1000)
    const payload = Credential.deserialize(serialized).payload as { validBefore: string }
    // now+600 — bracket against before/after to absorb clock ticks during the call.
    expect(Number(payload.validBefore)).toBeGreaterThanOrEqual(before + 600)
    expect(Number(payload.validBefore)).toBeLessThanOrEqual(after + 600)
  })

  test('explicit validAfter >= validBefore throws BEFORE signTypedData is invoked', async () => {
    const handler = await buildHandler()
    const challenge = await handler.challenge.evm.charge(fullRequest)

    const signSpy = vi.spyOn(ACCOUNT, 'signTypedData')
    try {
      const now = Math.floor(Date.now() / 1000)
      await expect(
        createAuthorizationCredential({
          challenge,
          account: ACCOUNT,
          chainId: CHAIN_ID,
          currency: USDC,
          recipient: RECIPIENT,
          amount: AMOUNT,
          eip712: EIP712,
          // Empty window: validAfter == validBefore, both in the future.
          validAfter: String(now + 300),
          validBefore: String(now + 300),
        }),
      ).rejects.toThrow(/validAfter .* >= validBefore .* empty validity window/)
      // The whole point: never cost the user a signing interaction for a
      // window the server is guaranteed to reject.
      expect(signSpy).not.toHaveBeenCalled()
    } finally {
      signSpy.mockRestore()
    }
  })
})

/* -------------------------------------------------------------------------- */
/*  Round-trip via server verifier                                            */
/* -------------------------------------------------------------------------- */

describe('createAuthorizationCredential — round-trip with server verifier', () => {
  test('handler.verifyCredential accepts client-built authorization credential', async () => {
    const handler = await buildHandler()
    const challenge = await handler.challenge.evm.charge(fullRequest)

    const serialized = await createAuthorizationCredential({
      challenge,
      account: ACCOUNT,
      chainId: CHAIN_ID,
      currency: USDC,
      recipient: RECIPIENT,
      amount: AMOUNT,
      eip712: EIP712,
    })

    const out = await handler.verifyCredential(serialized, { request: fullRequest })
    expect(out).toMatchObject({
      method: 'evm',
      status: 'success',
      challengeId: challenge.id,
      chainId: CHAIN_ID,
    })
  })
})
