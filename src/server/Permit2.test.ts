/**
 * Permit2 credential verifier unit tests (spec §8.1).
 *
 * Coverage matrix:
 *   - Local validation: deadline / length / token / recipient / amount /
 *     splits / witness mismatches all reject before any RPC or slot reserve.
 *   - credential.source REQUIRED + matches recovered signer.
 *   - Replay pre-state (consumed / rejected / inflight) terminates early.
 *   - On-chain: balance / allowance / simulate / revert all `release`
 *     (nonce unconsumed); post-success Transfer log mismatch `markRejected`
 *     (nonce consumed on-chain).
 *   - Happy single + happy batch (splits) end-to-end.
 */

import { Store } from 'mppx'
import {
  type Log,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
  encodeAbiParameters,
  encodeEventTopics,
  signatureToHex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { signTypedData } from 'viem/actions'
import { describe, expect, test, vi } from 'vitest'

import {
  failOnState,
  terminalFailureStore,
} from '../../test/helpers/server/terminalFailureStore.js'
import {
  computeChallengeHash,
  permit2BatchTypes,
  permit2Domain,
  permit2SingleTypes,
} from '../protocol/TypedData.js'
import { type Permit2VerifierArgs, type Permit2VerifierCtx, verifyPermit2 } from './Permit2.js'
import { type ChargeStore, permit2Key } from './Replay.js'

void signatureToHex // keep import alive for future signature-malleability tests

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

const CHAIN_ID = 1
const CURRENCY = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const // USDC
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3' as const
const RECIPIENT = '0x2222222222222222222222222222222222222222' as const
const SPLIT_RECIPIENT = '0x3333333333333333333333333333333333333333' as const
const AMOUNT = '1000000'
const SPLIT_AMOUNT = '100000'
const PRIMARY_AMOUNT = String(BigInt(AMOUNT) - BigInt(SPLIT_AMOUNT))
const REALM = 'https://test.example/'

const PK = '0x0303030303030303030303030303030303030303030303030303030303030303' as const
const ACCOUNT = privateKeyToAccount(PK)
const SIGNER = ACCOUNT.address
const NONCE = '12345'
const DEADLINE = String(Math.floor(Date.now() / 1000) + 600)

const SETTLEMENT_PK = '0x0404040404040404040404040404040404040404040404040404040404040404' as const
const SETTLEMENT_ACCOUNT = privateKeyToAccount(SETTLEMENT_PK)
// Permit2 spender = settlement signer's address. The user signs typed
// data with `spender = SETTLEMENT_ADDR` because Permit2's
// _hashWithWitness uses msg.sender as the spender field (which equals
// SETTLEMENT_ADDR when the server's settlementSigner calls Permit2).
const SETTLEMENT_ADDR = SETTLEMENT_ACCOUNT.address

const CHALLENGE_ID = 'chal_permit2_test'
const CHALLENGE_HASH = computeChallengeHash(CHALLENGE_ID, REALM)

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
  logIndex?: number
}): Log {
  const { from, to, value, address, logIndex = 0 } = args
  return {
    address,
    blockHash: `0x${'a'.repeat(64)}` as `0x${string}`,
    blockNumber: 100n,
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
    logIndex,
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
    to: PERMIT2,
    transactionHash: `0x${'d'.repeat(64)}` as `0x${string}`,
    transactionIndex: 0,
    type: 'eip1559',
  } as TransactionReceipt
}

interface StubPublicClientConfig {
  balance?: bigint
  allowance?: bigint
  simulateError?: Error
  receipt?: TransactionReceipt
  waitError?: Error
}

function stubPublicClient(config: StubPublicClientConfig = {}): PublicClient {
  return {
    async readContract({ functionName }: { functionName: string }) {
      if (functionName === 'balanceOf') return config.balance ?? BigInt(AMOUNT) * 10n
      if (functionName === 'allowance') return config.allowance ?? BigInt(AMOUNT) * 10n
      throw new Error(`unexpected readContract: ${functionName}`)
    },
    async simulateContract() {
      if (config.simulateError) throw config.simulateError
      return { result: undefined, request: {} }
    },
    async waitForTransactionReceipt() {
      if (config.waitError) throw config.waitError
      return config.receipt!
    },
  } as unknown as PublicClient
}

interface StubWalletConfig {
  writeError?: Error
  txHash?: `0x${string}`
}

function stubWalletClient(config: StubWalletConfig = {}): WalletClient {
  return {
    account: SETTLEMENT_ACCOUNT,
    chain: null,
    async writeContract() {
      if (config.writeError) throw config.writeError
      return config.txHash ?? (`0x${'e'.repeat(64)}` as `0x${string}`)
    },
  } as unknown as WalletClient
}

/** Sign the Permit2 single typed-data with the test SIGNER key. */
async function signSinglePermit(): Promise<`0x${string}`> {
  return signTypedData(
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
        witness: { challengeHash: CHALLENGE_HASH },
      },
    },
  )
}

/** Sign the Permit2 batch typed-data with the test SIGNER key (for splits). */
async function signBatchPermit(): Promise<`0x${string}`> {
  return signTypedData(
    { type: 'local', account: ACCOUNT } as unknown as Parameters<typeof signTypedData>[0],
    {
      account: ACCOUNT,
      domain: permit2Domain(CHAIN_ID, PERMIT2),
      types: permit2BatchTypes,
      primaryType: 'PermitBatchWitnessTransferFrom',
      message: {
        permitted: [
          { token: CURRENCY, amount: BigInt(PRIMARY_AMOUNT) },
          { token: CURRENCY, amount: BigInt(SPLIT_AMOUNT) },
        ],
        spender: SETTLEMENT_ADDR,
        nonce: BigInt(NONCE),
        deadline: BigInt(DEADLINE),
        witness: { challengeHash: CHALLENGE_HASH },
      },
    },
  )
}

function buildCredentialSingle(
  signature: `0x${string}`,
  overrides: {
    deadline?: string
    witnessHash?: `0x${string}`
    permittedToken?: `0x${string}`
    permittedAmount?: string
    transferTo?: `0x${string}`
    transferAmount?: string
    source?: string
  } = {},
): Permit2VerifierArgs['credential'] {
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
      type: 'permit2',
      permit: {
        permitted: [
          {
            token: overrides.permittedToken ?? CURRENCY,
            amount: overrides.permittedAmount ?? AMOUNT,
          },
        ],
        nonce: NONCE,
        deadline: overrides.deadline ?? DEADLINE,
      },
      transferDetails: [
        {
          to: overrides.transferTo ?? RECIPIENT,
          requestedAmount: overrides.transferAmount ?? AMOUNT,
        },
      ],
      witness: { challengeHash: overrides.witnessHash ?? CHALLENGE_HASH },
      signature,
    },
    source: overrides.source ?? `did:pkh:eip155:${CHAIN_ID}:${SIGNER}`,
  } as unknown as Permit2VerifierArgs['credential']
}

function buildCredentialBatch(signature: `0x${string}`): Permit2VerifierArgs['credential'] {
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
      type: 'permit2',
      permit: {
        permitted: [
          { token: CURRENCY, amount: PRIMARY_AMOUNT },
          { token: CURRENCY, amount: SPLIT_AMOUNT },
        ],
        nonce: NONCE,
        deadline: DEADLINE,
      },
      transferDetails: [
        { to: RECIPIENT, requestedAmount: PRIMARY_AMOUNT },
        { to: SPLIT_RECIPIENT, requestedAmount: SPLIT_AMOUNT },
      ],
      witness: { challengeHash: CHALLENGE_HASH },
      signature,
    },
    source: `did:pkh:eip155:${CHAIN_ID}:${SIGNER}`,
  } as unknown as Permit2VerifierArgs['credential']
}

const singleRequest: Permit2VerifierArgs['request'] = {
  amount: AMOUNT,
  currency: CURRENCY,
  recipient: RECIPIENT,
  // permit2Address is WIRE TRUTH — verifier reads from request,
  // not ctx. Tests that override (fork / custom Permit2) just change
  // this value and the verifier picks it up automatically.
  // permit2Spender: also wire truth — must equal ctx.settlementSigner's
  // account address (verifier cross-checks). Permit2 uses msg.sender as
  // the EIP-712 spender, so this address gets signed by the user.
  methodDetails: { permit2Address: PERMIT2, permit2Spender: SETTLEMENT_ADDR },
}

const batchRequest: Permit2VerifierArgs['request'] = {
  amount: AMOUNT,
  currency: CURRENCY,
  recipient: RECIPIENT,
  methodDetails: {
    permit2Address: PERMIT2,
    permit2Spender: SETTLEMENT_ADDR,
    splits: [{ recipient: SPLIT_RECIPIENT, amount: SPLIT_AMOUNT }],
  },
}

function buildCtx(
  overrides: Partial<Permit2VerifierCtx> & {
    publicClient: PublicClient
    settlementSigner: WalletClient
  },
): Permit2VerifierCtx {
  return {
    store: freshStore(),
    chainId: CHAIN_ID,
    ...overrides,
  }
}

/* -------------------------------------------------------------------------- */
/*  Happy paths                                                               */
/* -------------------------------------------------------------------------- */

describe('verifyPermit2 happy paths', () => {
  test('single-permit success → markConsumed + receipt', async () => {
    const sig = await signSinglePermit()
    const receipt = buildReceipt([
      transferLog({ from: SIGNER, to: RECIPIENT, value: BigInt(AMOUNT), address: CURRENCY }),
    ])
    const ctx = buildCtx({
      publicClient: stubPublicClient({ receipt }),
      settlementSigner: stubWalletClient(),
    })

    const out = await verifyPermit2({
      credential: buildCredentialSingle(sig),
      request: singleRequest,
      ctx,
    })

    expect(out.method).toBe('evm')
    expect(out.status).toBe('success')
    expect(out.chainId).toBe(CHAIN_ID)
    expect((await ctx.store.get(permit2Key(CHAIN_ID, PERMIT2, SIGNER, NONCE)))?.state).toBe(
      'consumed',
    )
  })

  test('batch-permit with splits → markConsumed + receipt', async () => {
    const sig = await signBatchPermit()
    const receipt = buildReceipt([
      transferLog({
        from: SIGNER,
        to: RECIPIENT,
        value: BigInt(PRIMARY_AMOUNT),
        address: CURRENCY,
        logIndex: 0,
      }),
      transferLog({
        from: SIGNER,
        to: SPLIT_RECIPIENT,
        value: BigInt(SPLIT_AMOUNT),
        address: CURRENCY,
        logIndex: 1,
      }),
    ])
    const ctx = buildCtx({
      publicClient: stubPublicClient({ receipt }),
      settlementSigner: stubWalletClient(),
    })

    const out = await verifyPermit2({
      credential: buildCredentialBatch(sig),
      request: batchRequest,
      ctx,
    })

    expect(out.method).toBe('evm')
    expect((await ctx.store.get(permit2Key(CHAIN_ID, PERMIT2, SIGNER, NONCE)))?.state).toBe(
      'consumed',
    )
  })

  test('single-permit with 64-byte EIP-2098 compact signature → success', async () => {
    // The wire schema (Methods.ts `evmSignature`) accepts both 65-byte
    // standard r||s||v and 64-byte EIP-2098 compact form. viem's
    // recoverTypedDataAddress AND the Permit2 contract both require the
    // 65-byte form; the verifier must normalize compact → standard
    // before either path. Without that normalization this throws
    // "invalid signature length" at the recover step.
    const { parseSignature, serializeCompactSignature, signatureToCompactSignature } =
      await import('viem')
    const standardSig = await signSinglePermit()
    // Round-trip: standard → compact (64 bytes / 128 hex chars without 0x).
    // viem requires standard sig → CompactSignature struct → hex.
    const compactSig = serializeCompactSignature(
      signatureToCompactSignature(parseSignature(standardSig)),
    )
    expect(compactSig.length - 2).toBe(128) // sanity: confirm we have 64-byte form

    const receipt = buildReceipt([
      transferLog({ from: SIGNER, to: RECIPIENT, value: BigInt(AMOUNT), address: CURRENCY }),
    ])
    const ctx = buildCtx({
      publicClient: stubPublicClient({ receipt }),
      settlementSigner: stubWalletClient(),
    })

    const out = await verifyPermit2({
      credential: buildCredentialSingle(compactSig),
      request: singleRequest,
      ctx,
    })

    expect(out.method).toBe('evm')
    expect(out.status).toBe('success')
    expect((await ctx.store.get(permit2Key(CHAIN_ID, PERMIT2, SIGNER, NONCE)))?.state).toBe(
      'consumed',
    )
  })

  test('batch-permit with 64-byte EIP-2098 compact signature → success', async () => {
    const { parseSignature, serializeCompactSignature, signatureToCompactSignature } =
      await import('viem')
    const standardSig = await signBatchPermit()
    const compactSig = serializeCompactSignature(
      signatureToCompactSignature(parseSignature(standardSig)),
    )
    expect(compactSig.length - 2).toBe(128)

    const receipt = buildReceipt([
      transferLog({
        from: SIGNER,
        to: RECIPIENT,
        value: BigInt(PRIMARY_AMOUNT),
        address: CURRENCY,
        logIndex: 0,
      }),
      transferLog({
        from: SIGNER,
        to: SPLIT_RECIPIENT,
        value: BigInt(SPLIT_AMOUNT),
        address: CURRENCY,
        logIndex: 1,
      }),
    ])
    const ctx = buildCtx({
      publicClient: stubPublicClient({ receipt }),
      settlementSigner: stubWalletClient(),
    })

    const out = await verifyPermit2({
      credential: buildCredentialBatch(compactSig),
      request: batchRequest,
      ctx,
    })

    expect(out.method).toBe('evm')
    expect(out.status).toBe('success')
  })
})

/* -------------------------------------------------------------------------- */
/*  Local validation failures                                                 */
/* -------------------------------------------------------------------------- */

describe('verifyPermit2 local validation (no slot reservation)', () => {
  test('expired deadline → throws', async () => {
    const sig = await signSinglePermit()
    const ctx = buildCtx({
      publicClient: stubPublicClient(),
      settlementSigner: stubWalletClient(),
    })
    await expect(
      verifyPermit2({
        credential: buildCredentialSingle(sig, { deadline: '0' }),
        request: singleRequest,
        ctx,
      }),
    ).rejects.toThrow(/deadline 0 <= now/)
  })

  test('token mismatch → throws', async () => {
    const sig = await signSinglePermit()
    const ctx = buildCtx({
      publicClient: stubPublicClient(),
      settlementSigner: stubWalletClient(),
    })
    await expect(
      verifyPermit2({
        credential: buildCredentialSingle(sig, {
          permittedToken: '0x9999999999999999999999999999999999999999',
        }),
        request: singleRequest,
        ctx,
      }),
    ).rejects.toThrow(/permitted\[0\].token .* != currency/)
  })

  test('recipient mismatch → throws', async () => {
    const sig = await signSinglePermit()
    const ctx = buildCtx({
      publicClient: stubPublicClient(),
      settlementSigner: stubWalletClient(),
    })
    await expect(
      verifyPermit2({
        credential: buildCredentialSingle(sig, {
          transferTo: '0x8888888888888888888888888888888888888888',
        }),
        request: singleRequest,
        ctx,
      }),
    ).rejects.toThrow(/transferDetails\[0\].to .* != recipient/)
  })

  test('witness.challengeHash mismatch → throws', async () => {
    const sig = await signSinglePermit()
    const ctx = buildCtx({
      publicClient: stubPublicClient(),
      settlementSigner: stubWalletClient(),
    })
    await expect(
      verifyPermit2({
        credential: buildCredentialSingle(sig, { witnessHash: `0x${'7'.repeat(64)}` }),
        request: singleRequest,
        ctx,
      }),
    ).rejects.toThrow(/witness.challengeHash mismatch/)
  })

  test('missing credential.source → throws (draft §6.1 REQUIRED)', async () => {
    const sig = await signSinglePermit()
    const ctx = buildCtx({
      publicClient: stubPublicClient(),
      settlementSigner: stubWalletClient(),
    })
    // Build a credential without source by hand to bypass the helper default.
    const cred = {
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
        witness: { challengeHash: CHALLENGE_HASH },
        signature: sig,
      },
    } as unknown as Permit2VerifierArgs['credential']

    await expect(
      verifyPermit2({
        credential: cred,
        request: singleRequest,
        ctx,
      }),
    ).rejects.toThrow(/requires credential.source/)
  })

  test('source mismatch → throws', async () => {
    const sig = await signSinglePermit()
    const ctx = buildCtx({
      publicClient: stubPublicClient(),
      settlementSigner: stubWalletClient(),
    })
    await expect(
      verifyPermit2({
        credential: buildCredentialSingle(sig, {
          source: `did:pkh:eip155:${CHAIN_ID}:0x4444444444444444444444444444444444444444`,
        }),
        request: singleRequest,
        ctx,
      }),
    ).rejects.toThrow(/does not match recovered Permit2 signer/)
  })
})

/* -------------------------------------------------------------------------- */
/*  On-chain pre-broadcast failures (release)                                 */
/* -------------------------------------------------------------------------- */

describe('verifyPermit2 on-chain pre-broadcast failures release the slot', () => {
  test('insufficient balance → release', async () => {
    const sig = await signSinglePermit()
    const ctx = buildCtx({
      publicClient: stubPublicClient({ balance: 1n }),
      settlementSigner: stubWalletClient(),
    })

    await expect(
      verifyPermit2({
        credential: buildCredentialSingle(sig),
        request: singleRequest,
        ctx,
      }),
    ).rejects.toThrow(/balance 1 < totalAmount/)

    expect(await ctx.store.get(permit2Key(CHAIN_ID, PERMIT2, SIGNER, NONCE))).toBeNull()
  })

  test('insufficient allowance → release', async () => {
    const sig = await signSinglePermit()
    const ctx = buildCtx({
      publicClient: stubPublicClient({ allowance: 1n }),
      settlementSigner: stubWalletClient(),
    })

    await expect(
      verifyPermit2({
        credential: buildCredentialSingle(sig),
        request: singleRequest,
        ctx,
      }),
    ).rejects.toThrow(/allowance.*< totalAmount/)

    expect(await ctx.store.get(permit2Key(CHAIN_ID, PERMIT2, SIGNER, NONCE))).toBeNull()
  })

  test('simulateContract reverts → release', async () => {
    const sig = await signSinglePermit()
    const ctx = buildCtx({
      publicClient: stubPublicClient({ simulateError: new Error('SignatureExpired') }),
      settlementSigner: stubWalletClient(),
    })

    await expect(
      verifyPermit2({
        credential: buildCredentialSingle(sig),
        request: singleRequest,
        ctx,
      }),
    ).rejects.toThrow(/simulate\/broadcast failed.*SignatureExpired/)

    expect(await ctx.store.get(permit2Key(CHAIN_ID, PERMIT2, SIGNER, NONCE))).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/*  Post-broadcast outcomes                                                   */
/* -------------------------------------------------------------------------- */

describe('verifyPermit2 post-broadcast', () => {
  test('reverted on-chain → release (nonce unconsumed)', async () => {
    const sig = await signSinglePermit()
    const receipt = buildReceipt([], 'reverted')
    const ctx = buildCtx({
      publicClient: stubPublicClient({ receipt }),
      settlementSigner: stubWalletClient(),
    })

    await expect(
      verifyPermit2({
        credential: buildCredentialSingle(sig),
        request: singleRequest,
        ctx,
      }),
    ).rejects.toThrow(/reverted on-chain/)

    expect(await ctx.store.get(permit2Key(CHAIN_ID, PERMIT2, SIGNER, NONCE))).toBeNull()
  })

  test('Transfer log mismatch after success → markRejected (nonce consumed)', async () => {
    const sig = await signSinglePermit()
    const wrongRecipient = '0x9999999999999999999999999999999999999999' as const
    // Receipt is success but Transfer log goes to wrong address.
    const receipt = buildReceipt([
      transferLog({
        from: SIGNER,
        to: wrongRecipient,
        value: BigInt(AMOUNT),
        address: CURRENCY,
      }),
    ])
    const ctx = buildCtx({
      publicClient: stubPublicClient({ receipt }),
      settlementSigner: stubWalletClient(),
    })

    await expect(
      verifyPermit2({
        credential: buildCredentialSingle(sig),
        request: singleRequest,
        ctx,
      }),
    ).rejects.toThrow(/no matching Transfer event/)

    expect((await ctx.store.get(permit2Key(CHAIN_ID, PERMIT2, SIGNER, NONCE)))?.state).toBe(
      'rejected',
    )
  })
})

/* -------------------------------------------------------------------------- */
/*  Replay pre-state                                                          */
/* -------------------------------------------------------------------------- */

describe('verifyPermit2 reads permit2Address from WIRE request', () => {
  test('fork / custom Permit2 override propagates through domain + allowance + replay key + write target', async () => {
    // Use a non-canonical Permit2 address — a fork / mirror deployment.
    // If the verifier mistakenly used ctx-baked PERMIT2 anywhere, the
    // EIP-712 recover would yield the wrong signer and the test would
    // fail at the source-match check; the replay slot would also be
    // keyed under the wrong address and not show up in the assertion.
    const FORK_PERMIT2 = '0x1234567890abcdef1234567890abcdef12345678' as const

    // Sign typed-data with FORK in the verifyingContract slot.
    const sig = await signTypedData(
      { type: 'local', account: ACCOUNT } as unknown as Parameters<typeof signTypedData>[0],
      {
        account: ACCOUNT,
        domain: permit2Domain(CHAIN_ID, FORK_PERMIT2),
        types: permit2SingleTypes,
        primaryType: 'PermitWitnessTransferFrom',
        message: {
          permitted: { token: CURRENCY, amount: BigInt(AMOUNT) },
          // spender is the settlement signer (msg.sender), NOT the
          // verifyingContract. The fork-permit2 test exercises
          // `permit2Address` override (= EIP-712 domain.verifyingContract)
          // — spender stays SETTLEMENT_ADDR independent of the fork.
          spender: SETTLEMENT_ADDR,
          nonce: BigInt(NONCE),
          deadline: BigInt(DEADLINE),
          witness: { challengeHash: CHALLENGE_HASH },
        },
      },
    )

    const receipt = buildReceipt([
      transferLog({ from: SIGNER, to: RECIPIENT, value: BigInt(AMOUNT), address: CURRENCY }),
    ])
    const ctx = buildCtx({
      publicClient: stubPublicClient({ receipt }),
      settlementSigner: stubWalletClient(),
    })

    const out = await verifyPermit2({
      // Build a credential with FORK in transferDetails witness path —
      // and the source DID points at our test signer.
      credential: {
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
          witness: { challengeHash: CHALLENGE_HASH },
          signature: sig,
        },
        source: `did:pkh:eip155:${CHAIN_ID}:${SIGNER}`,
      } as unknown as Permit2VerifierArgs['credential'],
      // Wire request carries the FORK address — verifier MUST read this,
      // not anything from ctx (which no longer has permit2Address).
      request: {
        amount: AMOUNT,
        currency: CURRENCY,
        recipient: RECIPIENT,
        methodDetails: { permit2Address: FORK_PERMIT2, permit2Spender: SETTLEMENT_ADDR },
      },
      ctx,
    })

    expect(out.method).toBe('evm')
    // Replay key uses the wire FORK address (not canonical PERMIT2).
    expect((await ctx.store.get(permit2Key(CHAIN_ID, FORK_PERMIT2, SIGNER, NONCE)))?.state).toBe(
      'consumed',
    )
    // Sanity: canonical PERMIT2 slot remains EMPTY — proves the verifier
    // did NOT silently use the const-baked address anywhere.
    expect(await ctx.store.get(permit2Key(CHAIN_ID, PERMIT2, SIGNER, NONCE))).toBeNull()
  })
})

describe('verifyPermit2 replay pre-state terminates early', () => {
  test('already consumed → terminal', async () => {
    const sig = await signSinglePermit()
    const store = freshStore()
    await store.update(permit2Key(CHAIN_ID, PERMIT2, SIGNER, NONCE), () => ({
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
      verifyPermit2({
        credential: buildCredentialSingle(sig),
        request: singleRequest,
        ctx,
      }),
    ).rejects.toThrow(/already consumed/)
  })
})

/* -------------------------------------------------------------------------- */
/*  Terminal-phase store-write failure must NOT release slot                   */
/* -------------------------------------------------------------------------- */

describe('verifyPermit2 — terminal-phase store-write failure keeps slot inflight', () => {
  test('markConsumed throws after on-chain success → slot stays inflight (no release)', async () => {
    // Models Redis transient outage right at the markConsumed CAS, AFTER
    // the Permit2 contract call succeeded on-chain. The Permit2 nonce
    // is consumed; releasing the slot here would re-admit the same
    // credential → next reserve+verify would re-call the Permit2 contract,
    // which would revert "InvalidNonce", confusing the user. Keeping
    // the slot inflight; TTL / operator handles cleanup.
    const sig = await signSinglePermit()
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
        verifyPermit2({
          credential: buildCredentialSingle(sig),
          request: singleRequest,
          ctx,
        }),
      ).rejects.toThrow(/ECONNRESET: Redis dropped right at markConsumed/)

      // CRITICAL: slot stays inflight.
      const slot = await store.get(permit2Key(CHAIN_ID, PERMIT2, SIGNER, NONCE))
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
    // Transfer log doesn't match expectations → verifier enters the
    // post-success markRejected path (Permit2.ts step 17 mismatch).
    // The Permit2 nonce IS consumed on-chain at this point; if the
    // markRejected store-write fails (Redis flaky right then), the
    // terminalPhase=true flag must STILL prevent the safety-net release. A
    // released slot would re-admit the credential → next attempt
    // would re-call Permit2, get the same log mismatch, try markRejected
    // again, fail again — and meanwhile the nonce-burn record is lost.
    const sig = await signSinglePermit()
    const wrongRecipient = '0x9999999999999999999999999999999999999999' as const
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
        verifyPermit2({
          credential: buildCredentialSingle(sig),
          request: singleRequest,
          ctx,
        }),
      ).rejects.toThrow(/ECONNRESET: Redis dropped right at markRejected/)

      const slot = await store.get(permit2Key(CHAIN_ID, PERMIT2, SIGNER, NONCE))
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
