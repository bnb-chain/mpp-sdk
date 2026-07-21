/**
 * `B402Adapter` (`@bnb-chain/mpp/b402/mppx`) — the b402 settlement backend.
 *
 *   1. Unit: success → SettleReceipt with a `facilitator` proof echoing
 *      payer/network/amount; failure+tx → 'reverted'; failure without tx →
 *      throws; success without a valid tx hash → SettlePendingError; resolveKind
 *      rejects an unknown token name; per-(network,token) kind selection.
 *   2. End-to-end via `verifyAuthorization` (no local signer): a matching
 *      facilitator settlement yields a success receipt + a consumed replay slot;
 *      a facilitator that echoes a DIFFERENT payer / network / amount than was
 *      authorized is REJECTED by the verifier (the trust-critical check lives in
 *      core, not the adapter).
 */

import { Store } from 'mppx'
import { type Log, type PublicClient, type TransactionReceipt } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vitest'

import { eip3009Domain, eip3009Nonce, eip3009Types } from '../../protocol/TypedData.js'
import { type AuthorizationVerifierArgs, verifyAuthorization } from '../../server/Authorization.js'
import {
  type Eip3009Settlement,
  SettlePendingError,
  SettleRejectedError,
} from '../../server/index.js'
import type { ChargeStore } from '../../server/Replay.js'
import type { B402Client } from '../Client.js'
import type { SupportedResponse } from '../Types.js'
import { B402Adapter } from './index.js'

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

const CHAIN_ID = 1
const NETWORK = 'eip155:1'
const CURRENCY = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const // USDC
const RECIPIENT = '0x2222222222222222222222222222222222222222' as const
const AMOUNT = '1000000'
const REALM = 'https://test.example/'
const TOKEN_NAME = 'USD Coin'
const TOKEN_VERSION = '2'
const SIGNER_ADDRESS = '0x1111111111111111111111111111111111111111' as const
const OTHER_PAYER = '0x3333333333333333333333333333333333333333' as const
const B402_TX = `0x${'a1'.repeat(32)}` as const

const ACCOUNT = privateKeyToAccount(
  '0x0505050505050505050505050505050505050505050505050505050505050505',
)
const CHALLENGE_ID = 'chal_b402_test'
const NONCE = eip3009Nonce(CHALLENGE_ID, REALM)
const NOW = Math.floor(Date.now() / 1000)

function freshStore(): ChargeStore {
  return Store.memory() as unknown as ChargeStore
}

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

function stubPublicClient(
  receiptOrError: TransactionReceipt | Error,
  balance = BigInt(AMOUNT) * 10n,
): PublicClient {
  return {
    async readContract({ functionName }: { functionName: string }) {
      if (functionName === 'balanceOf') return balance
      throw new Error(`unexpected readContract: ${functionName}`)
    },
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

/** The settle fields a scripted b402 response echoes back (payer/network/amount
 *  default to the authorized values; override to script a mismatch, or set
 *  `omitAmount` to model an out-of-spec success that omits the settled amount). */
interface ScriptedSettle {
  success: boolean
  transaction: string
  errorReason?: string
  payer?: string
  network?: string
  amount?: string
  omitAmount?: boolean
}

/** A fake B402Client recording the settle request and returning a scripted result. */
function fakeB402Client(
  settleResult: ScriptedSettle,
  kinds: SupportedResponse['kinds'] = [
    {
      x402Version: 2,
      scheme: 'exact',
      network: NETWORK,
      extra: {
        name: TOKEN_NAME,
        version: TOKEN_VERSION,
        assetTransferMethod: 'eip3009',
        signerAddress: SIGNER_ADDRESS,
      },
    },
  ],
): { client: B402Client; calls: { settle: unknown[] } } {
  const calls = { settle: [] as unknown[] }
  const client = {
    async supported(): Promise<SupportedResponse> {
      return { kinds, extensions: [], signers: { 'eip155:*': [SIGNER_ADDRESS] } }
    },
    async settle(request: unknown) {
      calls.settle.push(request)
      return {
        success: settleResult.success,
        transaction: settleResult.transaction,
        payer: settleResult.payer ?? ACCOUNT.address,
        network: settleResult.network ?? NETWORK,
        ...(settleResult.omitAmount ? {} : { amount: settleResult.amount ?? AMOUNT }),
        ...(settleResult.errorReason ? { errorReason: settleResult.errorReason } : {}),
      }
    },
  } as unknown as B402Client
  return { client, calls }
}

/* ── B402Adapter (unit) ───────────────────────────────────────────────────── */

describe('B402Adapter', () => {
  const ctx = { publicClient: {} as PublicClient, confirmations: 1 }

  test('success → SettleReceipt with a facilitator proof echoing payer/network/amount', async () => {
    const { client, calls } = fakeB402Client({ success: true, transaction: B402_TX })
    const out = await new B402Adapter(client).settleAuthorization(await settlement(), ctx)
    expect(out).toMatchObject({
      status: 'success',
      transactionHash: B402_TX,
      proof: {
        kind: 'facilitator',
        payer: ACCOUNT.address,
        network: NETWORK,
        amount: BigInt(AMOUNT),
      },
    })
    // the forwarded payload carries the exact authorization fields
    const sent = calls.settle[0] as {
      paymentPayload: { payload: { authorization: { from: string } } }
    }
    expect(sent.paymentPayload.payload.authorization.from).toBe(ACCOUNT.address)
  })

  test('failure WITH a tx → status "reverted" (verifier runs front-run probe)', async () => {
    const { client } = fakeB402Client({
      success: false,
      transaction: B402_TX,
      errorReason: 'invalid_transaction_state',
    })
    const out = await new B402Adapter(client).settleAuthorization(await settlement(), ctx)
    expect(out).toMatchObject({ status: 'reverted', transactionHash: B402_TX })
    expect(out.proof.kind).toBe('facilitator')
  })

  test('failure with NO tx → typed SettleRejectedError carrying the b402 reason', async () => {
    // Definitive pre-broadcast rejection: typed so the verifier RELEASES the
    // slot and surfaces this reason (instead of a front-run probe artifact).
    const { client } = fakeB402Client({
      success: false,
      transaction: '',
      errorReason: 'insufficient_funds',
    })
    const err = await new B402Adapter(client)
      .settleAuthorization(await settlement(), ctx)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SettleRejectedError)
    expect((err as Error).message).toMatch(/insufficient_funds/)
  })

  test('rejects when /supported has no matching eip3009 kind for the token name', async () => {
    const { client } = fakeB402Client({ success: true, transaction: B402_TX }, [])
    await expect(
      new B402Adapter(client).settleAuthorization(await settlement(), ctx),
    ).rejects.toThrow(/no exact\/eip3009/)
  })

  test('ignores a /supported kind advertised under a different x402Version', async () => {
    const v1Kind: SupportedResponse['kinds'] = [
      {
        x402Version: 1,
        scheme: 'exact',
        network: NETWORK,
        extra: {
          name: TOKEN_NAME,
          version: TOKEN_VERSION,
          assetTransferMethod: 'eip3009',
          signerAddress: SIGNER_ADDRESS,
        },
      },
    ]
    const { client } = fakeB402Client({ success: true, transaction: B402_TX }, v1Kind)
    await expect(
      new B402Adapter(client).settleAuthorization(await settlement(), ctx),
    ).rejects.toThrow(/no exact\/eip3009/)
  })

  test('success with no/invalid tx hash → SettlePendingError (never fabricate 0x + consume)', async () => {
    const { client } = fakeB402Client({ success: true, transaction: '' })
    await expect(
      new B402Adapter(client).settleAuthorization(await settlement(), ctx),
    ).rejects.toBeInstanceOf(SettlePendingError)
  })

  test('success WITHOUT a settled amount → SettlePendingError (incomplete = missing info → pending)', async () => {
    const { client } = fakeB402Client({ success: true, transaction: B402_TX, omitAmount: true })
    await expect(
      new B402Adapter(client).settleAuthorization(await settlement(), ctx),
    ).rejects.toBeInstanceOf(SettlePendingError)
  })

  test('one adapter selects the kind per (network, token) — not a stale first-call cache', async () => {
    const mkKind = (name: string, version: string): SupportedResponse['kinds'][number] => ({
      x402Version: 2,
      scheme: 'exact',
      network: NETWORK,
      extra: { name, version, assetTransferMethod: 'eip3009', signerAddress: SIGNER_ADDRESS },
    })
    const kinds: SupportedResponse['kinds'] = [
      mkKind('USD Coin', '2'),
      mkKind('United Stables', '1'),
    ]
    const { client, calls } = fakeB402Client({ success: true, transaction: B402_TX }, kinds)
    const adapter = new B402Adapter(client)
    await adapter.settleAuthorization(
      { ...(await settlement()), eip712: { name: 'USD Coin', version: '2' } },
      ctx,
    )
    await adapter.settleAuthorization(
      { ...(await settlement()), eip712: { name: 'United Stables', version: '1' } },
      ctx,
    )
    const reqs = calls.settle.map(
      (r) =>
        (r as { paymentRequirements: { extra: { name: string } } }).paymentRequirements.extra.name,
    )
    expect(reqs).toEqual(['USD Coin', 'United Stables']) // 2nd would be 'USD Coin' with the cache bug
  })

  test('selects the kind by (name, VERSION) — same name at two EIP-712 versions', async () => {
    const mkKind = (version: string): SupportedResponse['kinds'][number] => ({
      x402Version: 2,
      scheme: 'exact',
      network: NETWORK,
      extra: {
        name: 'USD Coin',
        version,
        assetTransferMethod: 'eip3009',
        signerAddress: SIGNER_ADDRESS,
      },
    })
    const { client, calls } = fakeB402Client({ success: true, transaction: B402_TX }, [
      mkKind('1'),
      mkKind('2'),
    ])
    await new B402Adapter(client).settleAuthorization(
      { ...(await settlement()), eip712: { name: 'USD Coin', version: '2' } },
      ctx,
    )
    const req = calls.settle[0] as { paymentRequirements: { extra: { version: string } } }
    expect(req.paymentRequirements.extra.version).toBe('2') // would be '1' if version were ignored
  })

  test('rejects when /supported has the name but not the requested version', async () => {
    const { client } = fakeB402Client({ success: true, transaction: B402_TX }, [
      {
        x402Version: 2,
        scheme: 'exact',
        network: NETWORK,
        extra: {
          name: 'USD Coin',
          version: '1',
          assetTransferMethod: 'eip3009',
          signerAddress: SIGNER_ADDRESS,
        },
      },
    ])
    await expect(
      new B402Adapter(client).settleAuthorization(
        { ...(await settlement()), eip712: { name: 'USD Coin', version: '2' } },
        ctx,
      ),
    ).rejects.toThrow(/no exact\/eip3009/)
  })

  test('declares it settles authorization', () => {
    expect(
      new B402Adapter(fakeB402Client({ success: true, transaction: B402_TX }).client).settles,
    ).toContain('authorization')
  })

  test('attaches opt-in Bazaar metadata to the settle payload extensions', async () => {
    const bazaar = {
      info: { input: { type: 'http', method: 'GET' } },
      schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' },
      description: 'premium market snapshot',
    }
    const { client, calls } = fakeB402Client({ success: true, transaction: B402_TX })
    await new B402Adapter(client, { bazaar }).settleAuthorization(await settlement(), ctx)
    const sent = calls.settle[0] as { paymentPayload: { extensions?: { bazaar?: unknown } } }
    expect(sent.paymentPayload.extensions?.bazaar).toEqual(bazaar)
  })

  test('omits payload extensions when no Bazaar metadata is configured', async () => {
    const { client, calls } = fakeB402Client({ success: true, transaction: B402_TX })
    await new B402Adapter(client).settleAuthorization(await settlement(), ctx)
    const sent = calls.settle[0] as { paymentPayload: { extensions?: unknown } }
    expect(sent.paymentPayload.extensions).toBeUndefined()
  })
})

/* ── End-to-end: verifyAuthorization via B402Adapter (no local signer) ──────── */

describe('verifyAuthorization with B402Adapter', () => {
  function credential(signature: `0x${string}`): AuthorizationVerifierArgs['credential'] {
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
        from: ACCOUNT.address,
        to: RECIPIENT,
        value: AMOUNT,
        validAfter: String(NOW - 60),
        validBefore: String(NOW + 600),
        nonce: NONCE,
        signature,
      },
    } as unknown as AuthorizationVerifierArgs['credential']
  }

  function argsFor(client: B402Client, store: ChargeStore): AuthorizationVerifierArgs {
    return {
      credential: credential(undefined as unknown as `0x${string}`),
      request: { amount: AMOUNT, currency: CURRENCY, recipient: RECIPIENT },
      ctx: {
        publicClient: stubPublicClient(receipt('success')), // only balanceOf is read
        store,
        chainId: CHAIN_ID,
        eip712: { name: TOKEN_NAME, version: TOKEN_VERSION },
        confirmations: 1,
        settleBackend: new B402Adapter(client),
      },
    } as unknown as AuthorizationVerifierArgs
  }

  async function args(client: B402Client, store: ChargeStore): Promise<AuthorizationVerifierArgs> {
    const a = argsFor(client, store)
    return { ...a, credential: credential(await signEip3009()) }
  }

  test('matching settlement → success receipt + consumed slot (no local signer)', async () => {
    const { client } = fakeB402Client({ success: true, transaction: B402_TX })
    const store = freshStore()
    const a = await args(client, store)

    const receiptOut = await verifyAuthorization(a)
    expect(receiptOut.status).toBe('success')
    expect(receiptOut.reference).toBe(B402_TX) // references the b402 settlement tx

    // The slot is now consumed — re-submitting the same credential must reject.
    await expect(verifyAuthorization(a)).rejects.toThrow(/consumed/)
  })

  test('facilitator echoes a DIFFERENT payer → rejected (settled a transfer we did not authorize)', async () => {
    const { client } = fakeB402Client({ success: true, transaction: B402_TX, payer: OTHER_PAYER })
    await expect(verifyAuthorization(await args(client, freshStore()))).rejects.toThrow(
      /does not match authorization/,
    )
  })

  test('facilitator echoes a DIFFERENT amount → rejected', async () => {
    const { client } = fakeB402Client({ success: true, transaction: B402_TX, amount: '999' })
    await expect(verifyAuthorization(await args(client, freshStore()))).rejects.toThrow(
      /does not match authorization/,
    )
  })

  test('facilitator echoes a DIFFERENT network → rejected', async () => {
    const { client } = fakeB402Client({
      success: true,
      transaction: B402_TX,
      network: 'eip155:56',
    })
    await expect(verifyAuthorization(await args(client, freshStore()))).rejects.toThrow(
      /does not match authorization/,
    )
  })

  test('facilitator echoes the SAME chain in a different CAIP format → accepted (no false reject)', async () => {
    // chainId is 1; an honest settlement may echo `EIP155:1` / `eip155:0x1` /
    // with whitespace — only cosmetic CAIP-2 format diffs, must NOT be rejected.
    for (const network of ['EIP155:1', 'eip155:0x1', ' eip155:1 ']) {
      const { client } = fakeB402Client({ success: true, transaction: B402_TX, network })
      const out = await verifyAuthorization(await args(client, freshStore()))
      expect(out.status).toBe('success')
    }
  })

  test('facilitator echoes an UNREADABLE network → rejected (fail closed; no on-chain check)', async () => {
    for (const network of ['bsc', '56', 'eip155:', 'eip155:abc']) {
      const { client } = fakeB402Client({ success: true, transaction: B402_TX, network })
      await expect(verifyAuthorization(await args(client, freshStore()))).rejects.toThrow(
        /does not match authorization/,
      )
    }
  })

  test('facilitator success WITHOUT an amount → pending error, NOT a verifier reject (missing info)', async () => {
    // Missing info (vs WRONG info): surfaces as the adapter's pending message,
    // not the verifier's "does not match" reject — the slot stays inflight rather
    // than terminally rejected.
    const { client } = fakeB402Client({ success: true, transaction: B402_TX, omitAmount: true })
    await expect(verifyAuthorization(await args(client, freshStore()))).rejects.toThrow(
      /echoed no settled amount/,
    )
  })
})
