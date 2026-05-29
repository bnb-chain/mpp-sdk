/**
 * EIP-3009 authorization verifier unit tests (spec §8.2).
 *
 * Coverage matrix:
 *   - Local validation (steps 1-8): each rejection has its own case;
 *     never reserves a slot.
 *   - On-chain pre-broadcast failures release the slot (nonce unconsumed).
 *   - Post-broadcast: revert → release; success + log mismatch → markRejected
 *     (token consumed nonce on-chain).
 *   - Happy path → markConsumed + receipt.
 *   - Replay pre-state terminal.
 */

import { Store } from 'mppx'
import {
  type Log,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
  encodeAbiParameters,
  encodeEventTopics,
  parseSignature,
  serializeCompactSignature,
  signatureToCompactSignature,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { signTypedData } from 'viem/actions'
import { describe, expect, test, vi } from 'vitest'

import {
  failOnState,
  terminalFailureStore,
} from '../../test/helpers/server/terminalFailureStore.js'
import { eip3009Domain, eip3009Nonce, eip3009Types } from '../protocol/TypedData.js'
import {
  type AuthorizationVerifierArgs,
  type AuthorizationVerifierCtx,
  verifyAuthorization,
} from './Authorization.js'
import { authKey, type ChargeStore } from './Replay.js'

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

const CHAIN_ID = 1
const CURRENCY = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const // USDC
const RECIPIENT = '0x2222222222222222222222222222222222222222' as const
const AMOUNT = '1000000'
const REALM = 'https://test.example/'
const TOKEN_NAME = 'USD Coin'
const TOKEN_VERSION = '2'
const EIP712 = { name: TOKEN_NAME, version: TOKEN_VERSION }

const PK = '0x0505050505050505050505050505050505050505050505050505050505050505' as const
const ACCOUNT = privateKeyToAccount(PK)
const SIGNER = ACCOUNT.address

const SETTLEMENT_PK = '0x0606060606060606060606060606060606060606060606060606060606060606' as const
const SETTLEMENT_ACCOUNT = privateKeyToAccount(SETTLEMENT_PK)

const CHALLENGE_ID = 'chal_auth_test'
const NONCE = eip3009Nonce(CHALLENGE_ID, REALM)
const NOW = Math.floor(Date.now() / 1000)
const VALID_AFTER = String(NOW - 60)
const VALID_BEFORE = String(NOW + 600)

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

function buildReceipt(logs: Log[], status: 'success' | 'reverted' = 'success'): TransactionReceipt {
  return {
    blockHash: `0x${'c'.repeat(64)}` as `0x${string}`,
    blockNumber: 100n,
    contractAddress: null,
    cumulativeGasUsed: 0n,
    effectiveGasPrice: 0n,
    from: SETTLEMENT_ACCOUNT.address,
    gasUsed: 0n,
    logs,
    logsBloom: '0x' as `0x${string}`,
    status,
    to: CURRENCY,
    transactionHash: `0x${'d'.repeat(64)}` as `0x${string}`,
    transactionIndex: 0,
    type: 'eip1559',
  } as TransactionReceipt
}

interface StubPublicClientConfig {
  balance?: bigint
  simulateError?: Error
  receipt?: TransactionReceipt
}

function stubPublicClient(config: StubPublicClientConfig = {}): PublicClient {
  return {
    async readContract({ functionName }: { functionName: string }) {
      if (functionName === 'balanceOf') return config.balance ?? BigInt(AMOUNT) * 10n
      throw new Error(`unexpected readContract: ${functionName}`)
    },
    async simulateContract() {
      if (config.simulateError) throw config.simulateError
      return { result: undefined, request: {} }
    },
    async waitForTransactionReceipt() {
      return config.receipt!
    },
  } as unknown as PublicClient
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

/** Sign a valid EIP-3009 authorization with the test SIGNER. */
async function signEip3009(
  overrides: Partial<{
    to: `0x${string}`
    value: string
    validAfter: string
    validBefore: string
    nonce: `0x${string}`
  }> = {},
): Promise<`0x${string}`> {
  const message = {
    from: SIGNER,
    to: overrides.to ?? RECIPIENT,
    value: BigInt(overrides.value ?? AMOUNT),
    validAfter: BigInt(overrides.validAfter ?? VALID_AFTER),
    validBefore: BigInt(overrides.validBefore ?? VALID_BEFORE),
    nonce: overrides.nonce ?? NONCE,
  }
  return signTypedData(
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
      message,
    },
  )
}

function buildCredential(
  signature: `0x${string}`,
  overrides: {
    to?: `0x${string}`
    value?: string
    nonce?: `0x${string}`
    validAfter?: string
    validBefore?: string
    source?: string
  } = {},
): AuthorizationVerifierArgs['credential'] {
  return {
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
      to: overrides.to ?? RECIPIENT,
      value: overrides.value ?? AMOUNT,
      validAfter: overrides.validAfter ?? VALID_AFTER,
      validBefore: overrides.validBefore ?? VALID_BEFORE,
      nonce: overrides.nonce ?? NONCE,
      signature,
    },
    ...(overrides.source !== undefined && { source: overrides.source }),
  } as unknown as AuthorizationVerifierArgs['credential']
}

const baseRequest: AuthorizationVerifierArgs['request'] = {
  amount: AMOUNT,
  currency: CURRENCY,
  recipient: RECIPIENT,
}

function buildCtx(
  overrides: Partial<AuthorizationVerifierCtx> & {
    publicClient: PublicClient
    settlementSigner: WalletClient
  },
): AuthorizationVerifierCtx {
  // Currency is wire-truth — read from request, not ctx.
  return {
    store: freshStore(),
    chainId: CHAIN_ID,
    eip712: EIP712,
    ...overrides,
  }
}

/* -------------------------------------------------------------------------- */
/*  Happy path                                                                */
/* -------------------------------------------------------------------------- */

describe('verifyAuthorization happy path', () => {
  test('returns receipt + markConsumed', async () => {
    const sig = await signEip3009()
    const receipt = buildReceipt([
      transferLog({ from: SIGNER, to: RECIPIENT, value: BigInt(AMOUNT), address: CURRENCY }),
    ])
    const ctx = buildCtx({
      publicClient: stubPublicClient({ receipt }),
      settlementSigner: stubWalletClient(),
    })

    const out = await verifyAuthorization({
      credential: buildCredential(sig),
      request: baseRequest,
      ctx,
    })

    expect(out.method).toBe('evm')
    expect(out.status).toBe('success')
    expect(out.chainId).toBe(CHAIN_ID)
    expect((await ctx.store.get(authKey(CHAIN_ID, CURRENCY, SIGNER, NONCE)))?.state).toBe(
      'consumed',
    )
  })

  test('source matching recovered signer → success', async () => {
    const sig = await signEip3009()
    const receipt = buildReceipt([
      transferLog({ from: SIGNER, to: RECIPIENT, value: BigInt(AMOUNT), address: CURRENCY }),
    ])
    const ctx = buildCtx({
      publicClient: stubPublicClient({ receipt }),
      settlementSigner: stubWalletClient(),
    })

    await expect(
      verifyAuthorization({
        credential: buildCredential(sig, { source: `did:pkh:eip155:${CHAIN_ID}:${SIGNER}` }),
        request: baseRequest,
        ctx,
      }),
    ).resolves.toBeDefined()
  })

  test('accepts EIP-2098 compact signature (64-byte form)', async () => {
    // Sign normally (65-byte r||s||v), then transcode to compact via
    // viem.signatureToCompactSignature + serializeCompactSignature.
    // The schema (src/Methods.ts evmSignature) accepts both lengths;
    // the verifier should now derive v from yParity for the contract call.
    const stdSig = await signEip3009()
    const compact = signatureToCompactSignature(parseSignature(stdSig))
    const compactHex = serializeCompactSignature(compact)
    // Sanity: compact is exactly 64 bytes (128 hex + 0x prefix).
    expect(compactHex).toMatch(/^0x[0-9a-fA-F]{128}$/)

    const receipt = buildReceipt([
      transferLog({ from: SIGNER, to: RECIPIENT, value: BigInt(AMOUNT), address: CURRENCY }),
    ])
    const ctx = buildCtx({
      publicClient: stubPublicClient({ receipt }),
      settlementSigner: stubWalletClient(),
    })

    await expect(
      verifyAuthorization({
        credential: buildCredential(compactHex),
        request: baseRequest,
        ctx,
      }),
    ).resolves.toBeDefined()
  })
})

/* -------------------------------------------------------------------------- */
/*  Local validation failures (steps 1-8)                                     */
/* -------------------------------------------------------------------------- */

describe('verifyAuthorization local validation', () => {
  test('payload.to != recipient', async () => {
    const sig = await signEip3009({ to: '0x9999999999999999999999999999999999999999' })
    const ctx = buildCtx({
      publicClient: stubPublicClient(),
      settlementSigner: stubWalletClient(),
    })
    await expect(
      verifyAuthorization({
        credential: buildCredential(sig, { to: '0x9999999999999999999999999999999999999999' }),
        request: baseRequest,
        ctx,
      }),
    ).rejects.toThrow(/payload.to .* != recipient/)
  })

  test('payload.value != amount', async () => {
    const sig = await signEip3009({ value: '999' })
    const ctx = buildCtx({
      publicClient: stubPublicClient(),
      settlementSigner: stubWalletClient(),
    })
    await expect(
      verifyAuthorization({
        credential: buildCredential(sig, { value: '999' }),
        request: baseRequest,
        ctx,
      }),
    ).rejects.toThrow(/payload.value 999 != amount/)
  })

  test('nonce derived from a different challenge', async () => {
    const wrongNonce = eip3009Nonce('different_challenge', REALM)
    const sig = await signEip3009({ nonce: wrongNonce })
    const ctx = buildCtx({
      publicClient: stubPublicClient(),
      settlementSigner: stubWalletClient(),
    })
    await expect(
      verifyAuthorization({
        credential: buildCredential(sig, { nonce: wrongNonce }),
        request: baseRequest,
        ctx,
      }),
    ).rejects.toThrow(/authorization nonce mismatch/)
  })

  test('validBefore in the past', async () => {
    const expired = String(NOW - 60)
    const sig = await signEip3009({ validBefore: expired })
    const ctx = buildCtx({
      publicClient: stubPublicClient(),
      settlementSigner: stubWalletClient(),
    })
    await expect(
      verifyAuthorization({
        credential: buildCredential(sig, { validBefore: expired }),
        request: baseRequest,
        ctx,
      }),
    ).rejects.toThrow(/validBefore .* <= now/)
  })

  test('validAfter in the future', async () => {
    const future = String(NOW + 600)
    const sig = await signEip3009({ validAfter: future })
    const ctx = buildCtx({
      publicClient: stubPublicClient(),
      settlementSigner: stubWalletClient(),
    })
    await expect(
      verifyAuthorization({
        credential: buildCredential(sig, { validAfter: future }),
        request: baseRequest,
        ctx,
      }),
    ).rejects.toThrow(/validAfter .* > now/)
  })

  test('source mismatch with recovered signer', async () => {
    const sig = await signEip3009()
    const ctx = buildCtx({
      publicClient: stubPublicClient(),
      settlementSigner: stubWalletClient(),
    })
    await expect(
      verifyAuthorization({
        credential: buildCredential(sig, {
          source: `did:pkh:eip155:${CHAIN_ID}:0x4444444444444444444444444444444444444444`,
        }),
        request: baseRequest,
        ctx,
      }),
    ).rejects.toThrow(/does not match recovered EIP-3009 signer/)
  })
})

/* -------------------------------------------------------------------------- */
/*  On-chain pre-broadcast failures (release)                                 */
/* -------------------------------------------------------------------------- */

describe('verifyAuthorization on-chain pre-broadcast failures release the slot', () => {
  test('insufficient balance → release', async () => {
    const sig = await signEip3009()
    const ctx = buildCtx({
      publicClient: stubPublicClient({ balance: 1n }),
      settlementSigner: stubWalletClient(),
    })

    await expect(
      verifyAuthorization({
        credential: buildCredential(sig),
        request: baseRequest,
        ctx,
      }),
    ).rejects.toThrow(/balance 1 < value/)

    expect(await ctx.store.get(authKey(CHAIN_ID, CURRENCY, SIGNER, NONCE))).toBeNull()
  })

  test('simulateContract reverts → release', async () => {
    const sig = await signEip3009()
    const ctx = buildCtx({
      publicClient: stubPublicClient({
        simulateError: new Error('FiatTokenV2: authorization is used'),
      }),
      settlementSigner: stubWalletClient(),
    })

    await expect(
      verifyAuthorization({
        credential: buildCredential(sig),
        request: baseRequest,
        ctx,
      }),
    ).rejects.toThrow(/simulate\/broadcast failed.*authorization is used/)

    expect(await ctx.store.get(authKey(CHAIN_ID, CURRENCY, SIGNER, NONCE))).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/*  Post-broadcast outcomes                                                   */
/* -------------------------------------------------------------------------- */

describe('verifyAuthorization post-broadcast outcomes', () => {
  test('reverted on-chain → release (nonce unconsumed)', async () => {
    const sig = await signEip3009()
    const receipt = buildReceipt([], 'reverted')
    const ctx = buildCtx({
      publicClient: stubPublicClient({ receipt }),
      settlementSigner: stubWalletClient(),
    })

    await expect(
      verifyAuthorization({
        credential: buildCredential(sig),
        request: baseRequest,
        ctx,
      }),
    ).rejects.toThrow(/reverted on-chain/)

    expect(await ctx.store.get(authKey(CHAIN_ID, CURRENCY, SIGNER, NONCE))).toBeNull()
  })

  test('Transfer log mismatch → markRejected (nonce consumed on-chain)', async () => {
    const sig = await signEip3009()
    // Receipt success but Transfer log goes elsewhere
    const wrongRecipient = '0x8888888888888888888888888888888888888888' as const
    const receipt = buildReceipt([
      transferLog({ from: SIGNER, to: wrongRecipient, value: BigInt(AMOUNT), address: CURRENCY }),
    ])
    const ctx = buildCtx({
      publicClient: stubPublicClient({ receipt }),
      settlementSigner: stubWalletClient(),
    })

    await expect(
      verifyAuthorization({
        credential: buildCredential(sig),
        request: baseRequest,
        ctx,
      }),
    ).rejects.toThrow(/no matching Transfer event/)

    expect((await ctx.store.get(authKey(CHAIN_ID, CURRENCY, SIGNER, NONCE)))?.state).toBe(
      'rejected',
    )
  })
})

/* -------------------------------------------------------------------------- */
/*  Replay pre-state                                                          */
/* -------------------------------------------------------------------------- */

describe('verifyAuthorization reads currency from WIRE request', () => {
  test('fork / non-curated token address propagates through domain + balanceOf + authKey + write target', async () => {
    // Use a non-curated token address (mirror / fork ERC-20). If the
    // verifier mistakenly used a ctx-baked currency anywhere, the
    // EIP-712 recover would yield a wrong signer (domain differs) and
    // source-match would fail; the replay slot would also be keyed
    // under the wrong address.
    const FORK_TOKEN = '0x9876543210abcdef9876543210abcdef98765432' as const

    // Sign with FORK_TOKEN as the EIP-712 domain target.
    const sig = await signTypedData(
      { type: 'local', account: ACCOUNT } as unknown as Parameters<typeof signTypedData>[0],
      {
        account: ACCOUNT,
        domain: eip3009Domain({
          tokenName: TOKEN_NAME,
          tokenVersion: TOKEN_VERSION,
          chainId: CHAIN_ID,
          tokenAddress: FORK_TOKEN,
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

    // Build a Transfer log emitted from FORK_TOKEN — verifier step 14
    // must match log.address against the WIRE currency (FORK_TOKEN), not
    // curated CURRENCY. If it used ctx-baked currency it would fail here.
    const forkReceipt = buildReceipt([
      {
        address: FORK_TOKEN,
        blockHash: `0x${'a'.repeat(64)}` as `0x${string}`,
        blockNumber: 100n,
        data: encodeAbiParameters([{ type: 'uint256' }], [BigInt(AMOUNT)]),
        logIndex: 0,
        removed: false,
        topics: encodeEventTopics({
          abi: TRANSFER_EVENT_ABI,
          eventName: 'Transfer',
          args: { from: SIGNER, to: RECIPIENT },
        }) as Log['topics'],
        transactionHash: `0x${'b'.repeat(64)}` as `0x${string}`,
        transactionIndex: 0,
      } as Log,
    ])
    const ctx = buildCtx({
      publicClient: stubPublicClient({ receipt: forkReceipt }),
      settlementSigner: stubWalletClient(),
    })

    const out = await verifyAuthorization({
      credential: buildCredential(sig),
      request: {
        amount: AMOUNT,
        currency: FORK_TOKEN, // wire currency
        recipient: RECIPIENT,
      },
      ctx,
    })

    expect(out.method).toBe('evm')
    // Replay key uses the wire FORK_TOKEN address (not curated CURRENCY).
    expect((await ctx.store.get(authKey(CHAIN_ID, FORK_TOKEN, SIGNER, NONCE)))?.state).toBe(
      'consumed',
    )
    // Sanity: curated CURRENCY slot remains EMPTY — proves the verifier
    // did NOT silently use any const-baked address.
    expect(await ctx.store.get(authKey(CHAIN_ID, CURRENCY, SIGNER, NONCE))).toBeNull()
  })
})

describe('verifyAuthorization replay pre-state', () => {
  test('already consumed → terminal', async () => {
    const sig = await signEip3009()
    const store = freshStore()
    await store.update(authKey(CHAIN_ID, CURRENCY, SIGNER, NONCE), () => ({
      op: 'set',
      value: { state: 'consumed' as const, ts: Date.now() },
      result: true as const,
    }))
    const ctx = buildCtx({
      store,
      publicClient: stubPublicClient(),
      settlementSigner: stubWalletClient(),
    })

    await expect(
      verifyAuthorization({
        credential: buildCredential(sig),
        request: baseRequest,
        ctx,
      }),
    ).rejects.toThrow(/already consumed/)
  })
})

/* -------------------------------------------------------------------------- */
/*  Terminal-phase store-write failure must NOT release slot                   */
/* -------------------------------------------------------------------------- */

describe('verifyAuthorization — terminal-phase store-write failure keeps slot inflight', () => {
  test('markConsumed throws after on-chain success → slot stays inflight (no release)', async () => {
    // Models Redis transient outage right at the markConsumed CAS, AFTER
    // the EIP-3009 transferWithAuthorization succeeded on-chain. The
    // token contract has burned the authorization nonce; releasing the
    // slot would re-admit the same credential → next reserve+verify
    // would re-call transferWithAuthorization, the token would revert
    // "FiatTokenV2: authorization is used or canceled". Keep inflight.
    const sig = await signEip3009()
    const receipt = buildReceipt([
      transferLog({ from: SIGNER, to: RECIPIENT, value: BigInt(AMOUNT), address: CURRENCY }),
    ])
    const store = terminalFailureStore({
      failOn: failOnState('consumed'),
      message: 'ECONNRESET: Redis dropped right at markConsumed',
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const ctx = buildCtx({
        store,
        publicClient: stubPublicClient({ receipt }),
        settlementSigner: stubWalletClient(),
      })

      await expect(
        verifyAuthorization({
          credential: buildCredential(sig),
          request: baseRequest,
          ctx,
        }),
      ).rejects.toThrow(/ECONNRESET: Redis dropped right at markConsumed/)

      // CRITICAL: slot stays inflight.
      const slot = await store.get(authKey(CHAIN_ID, CURRENCY, SIGNER, NONCE))
      expect(slot?.state).toBe('inflight')

      // Operator visibility.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/terminal-phase store write failed.*slot remains inflight/),
        expect.any(String),
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('markRejected throws on post-success log-mismatch → slot stays inflight (no release)', async () => {
    // The OTHER terminal branch: receipt.status === 'success' but the
    // Transfer log doesn't match (e.g. token contract emitted a Transfer
    // to a different recipient — possible with fork/mirror token
    // implementations). The EIP-3009 authorization nonce IS consumed
    // on-chain; the verifier enters the post-success markRejected path
    // (Authorization.ts step 14). If markRejected fails (Redis flaky
    // right then), the terminalPhase=true flag must STILL prevent the
    // safety-net release — otherwise the credential's nonce-burn record
    // is lost AND a retry would re-call transferWithAuthorization
    // expecting it to succeed.
    const sig = await signEip3009()
    const wrongRecipient = '0x8888888888888888888888888888888888888888' as const
    const receipt = buildReceipt([
      transferLog({ from: SIGNER, to: wrongRecipient, value: BigInt(AMOUNT), address: CURRENCY }),
    ])
    const store = terminalFailureStore({
      failOn: failOnState('rejected'),
      message: 'ECONNRESET: Redis dropped right at markRejected',
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const ctx = buildCtx({
        store,
        publicClient: stubPublicClient({ receipt }),
        settlementSigner: stubWalletClient(),
      })

      await expect(
        verifyAuthorization({
          credential: buildCredential(sig),
          request: baseRequest,
          ctx,
        }),
      ).rejects.toThrow(/ECONNRESET: Redis dropped right at markRejected/)

      const slot = await store.get(authKey(CHAIN_ID, CURRENCY, SIGNER, NONCE))
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
