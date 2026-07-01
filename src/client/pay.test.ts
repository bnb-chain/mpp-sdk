/**
 * pay({ policy }) — Phase-1 unified buyer surface (ADR-0003).
 *
 *   1. deriveLogicalPaths — a standard mpp challenge → routes + derived traits.
 *   2. selectRoute (the design heart) — hard constraints FILTER, mode RANKS,
 *      empty → fail-closed. Pure, exhaustively tested here.
 *   3. pay — fetch → derive → select → (fail-closed | build + retry), wiring only.
 */

import { Challenge } from 'mppx'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vitest'

import {
  type LogicalPath,
  NoAcceptableMethodError,
  type PayMode,
  type PayPolicy,
  PaymentRejectedError,
  PaymentSideEffectError,
  type SelectionContext,
  type WalletCapabilities,
  deriveLogicalPaths,
  pay,
  selectRoute,
} from './pay/index.js'

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

const CHAIN_ID = 97
const CURRENCY = '0x180bc1a9843a65d4116e44886fd3558515a56a49' as const
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3' as const
const RECIPIENT = '0x2222222222222222222222222222222222222222' as const
const AMOUNT = '1000000000000000000' // 1.0 @ 18 decimals
const REALM = 'https://demo.example/'

function challengeWith(credentialTypes?: readonly string[]): Challenge.Challenge {
  return {
    id: 'chal_pay_test',
    realm: REALM,
    method: 'evm',
    intent: 'charge',
    request: {
      amount: AMOUNT,
      currency: CURRENCY,
      recipient: RECIPIENT,
      methodDetails: {
        chainId: CHAIN_ID,
        permit2Address: PERMIT2,
        ...(credentialTypes && { credentialTypes }),
      },
    },
    expires: new Date(Date.now() + 60_000).toISOString(),
  } as unknown as Challenge.Challenge
}

const ALL_CAPS: WalletCapabilities = {
  canSignTypedData: true,
  canSignTransaction: true,
  canBroadcast: true,
  hasPermit2Allowance: true,
  knownEip712Domain: true,
}

function ctx(over: Partial<SelectionContext> = {}): SelectionContext {
  return {
    chainId: CHAIN_ID,
    tokenAddress: CURRENCY,
    amountBase: BigInt(AMOUNT),
    capabilities: ALL_CAPS,
    ...over,
  }
}

const ids = (paths: readonly LogicalPath[]): string[] => paths.map((p) => p.id)

/* ── deriveLogicalPaths ──────────────────────────────────────────────────── */

describe('deriveLogicalPaths', () => {
  test('absent credentialTypes → payer-funded default [transaction, hash] (draft §11.2)', () => {
    expect(ids(deriveLogicalPaths(challengeWith()))).toEqual(['mpp:transaction', 'mpp:hash'])
  })

  test('preserves the merchant credentialTypes ORDER and derives traits', () => {
    const paths = deriveLogicalPaths(
      challengeWith(['authorization', 'permit2', 'transaction', 'hash']),
    )
    expect(ids(paths)).toEqual(['mpp:authorization', 'mpp:permit2', 'mpp:transaction', 'mpp:hash'])
    const byId = Object.fromEntries(paths.map((p) => [p.method, p]))
    expect(byId.authorization).toMatchObject({
      gasless: true,
      requiresApproval: 'never',
      trust: 'merchant-settlement',
    })
    expect(byId.permit2).toMatchObject({
      gasless: true,
      requiresApproval: 'if-insufficient-allowance',
    })
    expect(byId.transaction).toMatchObject({ gasless: false, trust: 'merchant-settlement' })
    expect(byId.hash).toMatchObject({ gasless: false, trust: 'payer-broadcast' })
  })

  test('ignores a non-spec credential value defensively', () => {
    expect(
      ids(deriveLogicalPaths(challengeWith(['authorization', 'b402-permit2', 'hash']))),
    ).toEqual(['mpp:authorization', 'mpp:hash'])
  })
})

/* ── selectRoute — the heart ─────────────────────────────────────────────── */

describe('selectRoute · mode ranking', () => {
  test('auto keeps merchant order (first viable wins)', () => {
    const paths = deriveLogicalPaths(challengeWith(['permit2', 'authorization']))
    const r = selectRoute(paths, { mode: 'auto' }, ctx())
    expect(r.ok && r.route.id).toBe('mpp:permit2')
  })

  test('prefer-gasless lifts a gasless route above a merchant-preferred buyer-funded one', () => {
    const paths = deriveLogicalPaths(challengeWith(['transaction', 'authorization']))
    const r = selectRoute(paths, { mode: 'prefer-gasless' }, ctx())
    expect(r.ok && r.route.id).toBe('mpp:authorization')
  })

  test('require-gasless fails closed when no route is gasless', () => {
    const paths = deriveLogicalPaths(challengeWith(['transaction', 'hash']))
    const r = selectRoute(paths, { mode: 'require-gasless' }, ctx())
    expect(r.ok).toBe(false)
  })

  test('an unknown mode throws (fail-closed, not a silent prefer-direct)', () => {
    const paths = deriveLogicalPaths(challengeWith(['authorization', 'hash']))
    // A JS caller or env typo (e.g. 'require-gassless') smuggles an invalid mode.
    expect(() => selectRoute(paths, { mode: 'require-gassless' as PayMode }, ctx())).toThrow(
      /unknown policy\.mode/,
    )
  })

  test('manual orders by routePreference and excludes unlisted routes', () => {
    const paths = deriveLogicalPaths(challengeWith(['authorization', 'permit2', 'hash']))
    const r = selectRoute(
      paths,
      { mode: 'manual' },
      ctx({ routePreference: ['mpp:permit2', 'mpp:authorization'] }),
    )
    expect(r.ok && r.route.id).toBe('mpp:permit2')
    expect(r.ok && ids(r.ranked)).toEqual(['mpp:permit2', 'mpp:authorization']) // 'mpp:hash' excluded
  })
})

describe('selectRoute · hard filters', () => {
  const all = () =>
    deriveLogicalPaths(challengeWith(['authorization', 'permit2', 'transaction', 'hash']))

  test('allowPayerGas:false drops the buyer-funded routes', () => {
    const r = selectRoute(all(), { allowPayerGas: false }, ctx())
    expect(r.ok && ids(r.ranked)).toEqual(['mpp:authorization', 'mpp:permit2'])
  })

  test('allowApproval:false drops permit2 ONLY when an approve is needed', () => {
    const need = selectRoute(
      all(),
      { allowApproval: false },
      ctx({ capabilities: { ...ALL_CAPS, hasPermit2Allowance: false } }),
    )
    expect(need.ok && ids(need.ranked)).not.toContain('mpp:permit2')
    const have = selectRoute(
      all(),
      { allowApproval: false },
      ctx({ capabilities: { ...ALL_CAPS, hasPermit2Allowance: true } }),
    )
    expect(have.ok && ids(have.ranked)).toContain('mpp:permit2')
  })

  test('allowedAssets filters by (chainId, address) — the wire identity, not symbol', () => {
    const OTHER = '0x1111111111111111111111111111111111111111' as const
    // Same address, wrong chain → excluded.
    expect(
      selectRoute(all(), { allowedAssets: [{ chainId: 56, address: CURRENCY }] }, ctx()).ok,
    ).toBe(false)
    // Right chain, different address → excluded.
    expect(
      selectRoute(all(), { allowedAssets: [{ chainId: CHAIN_ID, address: OTHER }] }, ctx()).ok,
    ).toBe(false)
    // Right chain + address → allowed.
    expect(
      selectRoute(all(), { allowedAssets: [{ chainId: CHAIN_ID, address: CURRENCY }] }, ctx()).ok,
    ).toBe(true)
  })

  test('allowedAssets address compare is case-insensitive (checksummed vs lowercase)', () => {
    const CHECKSUMMED = '0x180Bc1a9843A65D4116e44886FD3558515a56A49' as const
    expect(
      selectRoute(all(), { allowedAssets: [{ chainId: CHAIN_ID, address: CHECKSUMMED }] }, ctx())
        .ok,
    ).toBe(true)
  })

  test('allowedChains matches the numeric chainId only', () => {
    expect(selectRoute(all(), { allowedChains: [56] }, ctx()).ok).toBe(false)
    expect(selectRoute(all(), { allowedChains: [97] }, ctx()).ok).toBe(true)
    expect(selectRoute(all(), { allowedChains: [56, 97] }, ctx()).ok).toBe(true)
  })

  test('maxAmount ceiling filters by base units', () => {
    expect(selectRoute(all(), {}, ctx({ maxAmountBase: BigInt(AMOUNT) - 1n })).ok).toBe(false)
    expect(selectRoute(all(), {}, ctx({ maxAmountBase: BigInt(AMOUNT) })).ok).toBe(true)
  })

  test('wallet capability gates each method', () => {
    const noTyped = selectRoute(
      all(),
      {},
      ctx({ capabilities: { ...ALL_CAPS, canSignTypedData: false } }),
    )
    expect(noTyped.ok && ids(noTyped.ranked)).toEqual(['mpp:transaction', 'mpp:hash'])
    const noDomain = selectRoute(
      all(),
      {},
      ctx({ capabilities: { ...ALL_CAPS, knownEip712Domain: false } }),
    )
    expect(noDomain.ok && ids(noDomain.ranked)).not.toContain('mpp:authorization')
    expect(noDomain.ok && ids(noDomain.ranked)).toContain('mpp:permit2')
    const noBroadcast = selectRoute(
      all(),
      {},
      ctx({ capabilities: { ...ALL_CAPS, canBroadcast: false } }),
    )
    expect(noBroadcast.ok && ids(noBroadcast.ranked)).not.toContain('mpp:hash')
  })

  test('empty viable set → fail-closed with per-route reasons', () => {
    const r = selectRoute(
      all(),
      { allowPayerGas: false },
      ctx({ capabilities: { ...ALL_CAPS, canSignTypedData: false } }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toMatch(/no acceptable/)
      expect(r.rejected.length).toBe(4)
    }
  })
})

/* ── pay — wiring (fail-closed path, no on-chain build) ──────────────────── */

describe('pay', () => {
  test('fetches the 402, then fails closed when policy excludes every route (no retry)', async () => {
    const wwwAuth = Challenge.serialize(challengeWith(['authorization', 'permit2']))
    const calls: string[] = []
    const stubFetch = (async (input: string, init?: RequestInit) => {
      calls.push(init?.headers ? 'retry' : 'probe')
      return new Response(null, { status: 402, headers: { 'WWW-Authenticate': wwwAuth } })
    }) as unknown as typeof fetch

    const account = privateKeyToAccount(
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    )
    const publicClient = {
      async readContract({ functionName }: { functionName: string }) {
        if (functionName === 'decimals') return 18
        if (functionName === 'allowance') return 0n
        throw new Error(`unexpected readContract: ${functionName}`)
      },
    } as never
    const walletClient = { chain: { name: 'bsc-testnet' } } as never

    await expect(
      pay('https://api.example/report', {
        wallet: { account, publicClient, walletClient },
        // The challenge is for CURRENCY, but the buyer only allows a different
        // asset → every route filtered out.
        policy: {
          allowedAssets: [{ chainId: CHAIN_ID, address: RECIPIENT }],
        } satisfies PayPolicy,
        fetch: stubFetch,
      }),
    ).rejects.toBeInstanceOf(NoAcceptableMethodError)

    expect(calls).toEqual(['probe']) // never retried — failed closed before building
  })
})

/* ── pay — success + post-build fail-closed (the build/retry half) ────────── */

const PERMIT2_SPENDER = '0x3333333333333333333333333333333333333333' as const
const VALID_TXHASH = `0x${'a'.repeat(64)}` as const

function payAccount() {
  return privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
}

/** viem-shaped stubs: symbol/decimals/allowance reads + a writeContract that
 *  records which function was called (so tests can assert approve/transfer).
 *  `chainId` is the WALLET client's chain; `publicChainId`, when set, pins the
 *  PUBLIC (reader) client to a possibly-different chain so the independent
 *  chain check can be exercised on each side. */
function payClients(
  opts: {
    allowance?: bigint
    decimalsThrows?: boolean
    chainId?: number
    publicChainId?: number
    /** Status the confirmed tx receipt reports (default `'success'`). */
    receiptStatus?: 'success' | 'reverted'
    /** Make `waitForTransactionReceipt` throw (a timeout / RPC error). */
    receiptThrows?: boolean
  } = {},
) {
  const writeCalls: string[] = []
  const publicClient = {
    ...(opts.publicChainId !== undefined && {
      chain: { id: opts.publicChainId, name: 'bsc-testnet' },
    }),
    async readContract({ functionName }: { functionName: string }) {
      if (functionName === 'symbol') return 'U'
      if (functionName === 'decimals') {
        if (opts.decimalsThrows) throw new Error('decimals() reverted')
        return 18
      }
      if (functionName === 'allowance') return opts.allowance ?? 0n
      throw new Error(`unexpected readContract: ${functionName}`)
    },
    async waitForTransactionReceipt() {
      if (opts.receiptThrows) throw new Error('receipt wait timed out')
      return { status: opts.receiptStatus ?? 'success' }
    },
  } as never
  const walletClient = {
    chain: { id: opts.chainId ?? CHAIN_ID, name: 'bsc-testnet' },
    async writeContract({ functionName }: { functionName: string }) {
      writeCalls.push(functionName)
      return VALID_TXHASH
    },
  } as never
  return { publicClient, walletClient, writeCalls }
}

/** 402-then-retry fetch stub; retry status + optional Payment-Receipt configurable. */
function payFetch(wwwAuth: string, retry: { status: number; receipt?: string }) {
  const calls: string[] = []
  const fn = (async (_input: string, init?: RequestInit) => {
    if (!init?.headers) {
      calls.push('probe')
      return new Response(null, { status: 402, headers: { 'WWW-Authenticate': wwwAuth } })
    }
    calls.push('retry')
    const headers: Record<string, string> = {}
    if (retry.receipt) headers['Payment-Receipt'] = retry.receipt
    return new Response('{"ok":true}', { status: retry.status, headers })
  }) as unknown as typeof fetch
  return { fetch: fn, calls }
}

function permit2Challenge(): Challenge.Challenge {
  return {
    id: 'chal_pay_test',
    realm: REALM,
    method: 'evm',
    intent: 'charge',
    request: {
      amount: AMOUNT,
      currency: CURRENCY,
      recipient: RECIPIENT,
      methodDetails: {
        chainId: CHAIN_ID,
        permit2Address: PERMIT2,
        permit2Spender: PERMIT2_SPENDER,
        credentialTypes: ['permit2'],
      },
    },
    expires: new Date(Date.now() + 60_000).toISOString(),
  } as unknown as Challenge.Challenge
}

describe('pay · build + retry', () => {
  test('hash route: broadcasts, retries, surfaces route + receipt', async () => {
    const wwwAuth = Challenge.serialize(challengeWith(['hash']))
    const { publicClient, walletClient, writeCalls } = payClients()
    const { fetch, calls } = payFetch(wwwAuth, { status: 200, receipt: 'receipt-xyz' })

    const result = await pay('https://api.example/report', {
      wallet: { account: payAccount(), publicClient, walletClient },
      fetch,
    })

    expect(result.route.id).toBe('mpp:hash')
    expect(result.receiptHeader).toBe('receipt-xyz')
    expect(writeCalls).toEqual(['transfer']) // the buyer-broadcast settlement
    expect(calls).toEqual(['probe', 'retry'])
  })

  test('non-2xx retry → PaymentRejectedError carries the built credential (buyer broadcast, but NOT marked paid)', async () => {
    const wwwAuth = Challenge.serialize(challengeWith(['hash']))
    const { publicClient, walletClient, writeCalls } = payClients()
    let sentAuth: string | null = null
    const fetchStub = (async (_url: string, init?: RequestInit) => {
      if (!init?.headers) {
        return new Response(null, { status: 402, headers: { 'WWW-Authenticate': wwwAuth } })
      }
      sentAuth = new Headers(init.headers).get('Authorization')
      return new Response('rejected', { status: 402 })
    }) as unknown as typeof fetch

    const err = await pay('https://api.example/report', {
      wallet: { account: payAccount(), publicClient, walletClient },
      fetch: fetchStub,
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(PaymentRejectedError)
    const rejected = err as PaymentRejectedError
    expect(rejected.status).toBe(402)
    expect(rejected.route.id).toBe('mpp:hash')
    expect(writeCalls).toEqual(['transfer']) // it DID broadcast — that's exactly why silent success would be a footgun
    // The caller can reconcile / resubmit the SAME credential instead of a
    // fresh pay() call (which would re-sign / re-broadcast).
    expect(rejected.credential).toMatch(/^Payment /)
    expect(rejected.credential).toBe(sentAuth)
  })

  test('2xx retry without Payment-Receipt → receiptHeader null, still succeeds', async () => {
    const wwwAuth = Challenge.serialize(challengeWith(['hash']))
    const { publicClient, walletClient } = payClients()
    const { fetch } = payFetch(wwwAuth, { status: 200 })

    const result = await pay('https://api.example/report', {
      wallet: { account: payAccount(), publicClient, walletClient },
      fetch,
    })
    expect(result.receiptHeader).toBeNull()
  })

  test('maxAmount set but decimals unresolved → fail closed (throws, never broadcasts)', async () => {
    const wwwAuth = Challenge.serialize(challengeWith(['hash']))
    const { publicClient, walletClient, writeCalls } = payClients({ decimalsThrows: true })
    const { fetch, calls } = payFetch(wwwAuth, { status: 200 })

    await expect(
      pay('https://api.example/report', {
        wallet: { account: payAccount(), publicClient, walletClient },
        policy: { maxAmount: '1.00' },
        fetch,
      }),
    ).rejects.toThrow(/decimals could not be resolved/)

    expect(writeCalls).toEqual([]) // never reached the build step
    expect(calls).toEqual(['probe']) // never retried
  })

  test('chain mismatch throws; allowChainMismatch overrides', async () => {
    const wwwAuth = Challenge.serialize(challengeWith(['hash']))
    const a = payClients({ chainId: 1 }) // wallet on chain 1, challenge on 97
    const f1 = payFetch(wwwAuth, { status: 200, receipt: 'r' })
    await expect(
      pay('https://api.example/report', {
        wallet: {
          account: payAccount(),
          publicClient: a.publicClient,
          walletClient: a.walletClient,
        },
        fetch: f1.fetch,
      }),
    ).rejects.toThrow(/allowChainMismatch/)
    expect(a.writeCalls).toEqual([]) // never got past the chain gate

    const b = payClients({ chainId: 1 })
    const f2 = payFetch(wwwAuth, { status: 200, receipt: 'r' })
    const result = await pay('https://api.example/report', {
      wallet: { account: payAccount(), publicClient: b.publicClient, walletClient: b.walletClient },
      allowChainMismatch: true,
      fetch: f2.fetch,
    })
    expect(result.route.id).toBe('mpp:hash')
  })

  test('a divergent PUBLIC client fails closed even when the wallet matches (no `??` masking)', async () => {
    const wwwAuth = Challenge.serialize(challengeWith(['hash']))
    // Wallet on the challenge chain (97), but the READER pinned to chain 1 —
    // exactly the case the old `walletClient.chain ?? publicClient.chain` let through.
    const { publicClient, walletClient, writeCalls } = payClients({
      chainId: CHAIN_ID,
      publicChainId: 1,
    })
    const { fetch, calls } = payFetch(wwwAuth, { status: 200, receipt: 'r' })

    await expect(
      pay('https://api.example/report', {
        wallet: { account: payAccount(), publicClient, walletClient },
        fetch,
      }),
    ).rejects.toThrow(/public client is on chain 1/)

    expect(writeCalls).toEqual([]) // never read allowance / broadcast on the wrong chain
    expect(calls).toEqual(['probe']) // never retried
  })

  test('permit2 route: approves when allowance is short, then builds', async () => {
    const wwwAuth = Challenge.serialize(permit2Challenge())
    const { publicClient, walletClient, writeCalls } = payClients({ allowance: 0n })
    const { fetch } = payFetch(wwwAuth, { status: 200, receipt: 'r' })

    const result = await pay('https://api.example/report', {
      wallet: { account: payAccount(), publicClient, walletClient },
      policy: { mode: 'auto', allowApproval: true },
      fetch,
    })

    expect(result.route.id).toBe('mpp:permit2')
    expect(writeCalls).toEqual(['approve']) // one-time Permit2 approval, no transfer (merchant settles)
  })
})

/* ── pay — HTTP request shape (probe + retry reuse the caller's request) ──── */

/** Capturing fetch: records every init; probe (no Authorization) → 402, retry → 200. */
function capturingFetch(wwwAuth: string) {
  const inits: RequestInit[] = []
  const fn = (async (_input: string, init?: RequestInit) => {
    inits.push(init ?? {})
    const hasAuth = init?.headers ? new Headers(init.headers).has('Authorization') : false
    if (!hasAuth) {
      return new Response(null, { status: 402, headers: { 'WWW-Authenticate': wwwAuth } })
    }
    return new Response('{"ok":true}', { status: 200, headers: { 'Payment-Receipt': 'r' } })
  }) as unknown as typeof fetch
  return { fetch: fn, inits }
}

describe('pay · request shape', () => {
  test('carries method/headers/body on BOTH probe and retry; retry adds Authorization', async () => {
    const wwwAuth = Challenge.serialize(challengeWith(['hash']))
    const { publicClient, walletClient } = payClients()
    const { fetch, inits } = capturingFetch(wwwAuth)
    const body = JSON.stringify({ q: 'hi' })

    const result = await pay('https://api.example/report', {
      wallet: { account: payAccount(), publicClient, walletClient },
      request: {
        method: 'POST',
        headers: { 'X-Api-Key': 'secret', Accept: 'application/json' },
        body,
      },
      fetch,
    })

    expect(result.route.id).toBe('mpp:hash')
    expect(inits).toHaveLength(2)
    const [probe, retry] = inits as [RequestInit, RequestInit]

    // probe — the caller's request verbatim, NO Authorization
    expect(probe.method).toBe('POST')
    expect(probe.body).toBe(body)
    expect(new Headers(probe.headers).get('X-Api-Key')).toBe('secret')
    expect(new Headers(probe.headers).get('Accept')).toBe('application/json')
    expect(new Headers(probe.headers).has('Authorization')).toBe(false)

    // retry — same method/body/headers PLUS the credential
    expect(retry.method).toBe('POST')
    expect(retry.body).toBe(body)
    expect(new Headers(retry.headers).get('X-Api-Key')).toBe('secret')
    expect(new Headers(retry.headers).get('Authorization')).toMatch(/^Payment /)
  })

  test('a ReadableStream body is rejected up front (not replayable)', async () => {
    const wwwAuth = Challenge.serialize(challengeWith(['hash']))
    const { publicClient, walletClient, writeCalls } = payClients()
    const { fetch, inits } = capturingFetch(wwwAuth)

    await expect(
      pay('https://api.example/report', {
        wallet: { account: payAccount(), publicClient, walletClient },
        request: { method: 'POST', body: new ReadableStream() },
        fetch,
      }),
    ).rejects.toThrow(/replayable|ReadableStream/)

    expect(inits).toEqual([]) // rejected before the probe
    expect(writeCalls).toEqual([])
  })

  test('a body without an explicit non-GET/HEAD method is rejected', async () => {
    const wwwAuth = Challenge.serialize(challengeWith(['hash']))
    const { publicClient, walletClient } = payClients()
    const { fetch, inits } = capturingFetch(wwwAuth)

    await expect(
      pay('https://api.example/report', {
        wallet: { account: payAccount(), publicClient, walletClient },
        request: { body: 'oops' }, // no method → GET → cannot carry a body
        fetch,
      }),
    ).rejects.toThrow(/non-GET\/HEAD method/)

    expect(inits).toEqual([])
  })

  test('a caller-set Authorization header is rejected (reserved for the credential)', async () => {
    const wwwAuth = Challenge.serialize(challengeWith(['hash']))
    const { publicClient, walletClient, writeCalls } = payClients()
    const { fetch, inits } = capturingFetch(wwwAuth)

    await expect(
      pay('https://api.example/report', {
        wallet: { account: payAccount(), publicClient, walletClient },
        request: { headers: { Authorization: 'Bearer app-token' } },
        fetch,
      }),
    ).rejects.toThrow(/must not set Authorization/)

    expect(inits).toEqual([]) // rejected before the probe — nothing signed/broadcast
    expect(writeCalls).toEqual([])
  })
})

/* ── pay — allowApproval is a BUILD-time hard constraint (TOCTOU) ─────────── */

describe('pay · allowApproval enforcement', () => {
  test('allowApproval:false fails closed at build even if selection passed', async () => {
    const wwwAuth = Challenge.serialize(permit2Challenge())
    // allowance: sufficient at SELECT (facts read #1 → permit2 viable under
    // allowApproval:false) then short at BUILD (read #2 → must refuse, not approve).
    const allowances = [BigInt(AMOUNT), 0n]
    let i = 0
    const publicClient = {
      chain: { id: CHAIN_ID, name: 'bsc-testnet' },
      async readContract({ functionName }: { functionName: string }) {
        if (functionName === 'decimals') return 18
        if (functionName === 'allowance') return allowances[Math.min(i++, allowances.length - 1)]
        throw new Error(`unexpected readContract: ${functionName}`)
      },
      async waitForTransactionReceipt() {
        return { status: 'success' }
      },
    } as never
    const writeCalls: string[] = []
    const walletClient = {
      chain: { id: CHAIN_ID, name: 'bsc-testnet' },
      async writeContract({ functionName }: { functionName: string }) {
        writeCalls.push(functionName)
        return VALID_TXHASH
      },
    } as never
    const { fetch } = payFetch(wwwAuth, { status: 200, receipt: 'r' })

    await expect(
      pay('https://api.example/report', {
        wallet: { account: payAccount(), publicClient, walletClient },
        policy: { mode: 'auto', allowApproval: false },
        fetch,
      }),
    ).rejects.toThrow(/allowApproval is false|refusing to send an approve/)

    expect(writeCalls).toEqual([]) // never approved
  })
})

/* ── pay — validate-before-side-effect + post-side-effect reconciliation ──── */

describe('pay · failure paths', () => {
  test('permit2 with a MISSING permit2Spender fails before any approve (no state change)', async () => {
    // challengeWith omits permit2Spender — createPermit2Credential would reject
    // it, but only AFTER a max approve. The pre-validation must catch it first.
    const wwwAuth = Challenge.serialize(challengeWith(['permit2']))
    const { publicClient, walletClient, writeCalls } = payClients({ allowance: 0n })
    const { fetch, calls } = payFetch(wwwAuth, { status: 200, receipt: 'r' })

    await expect(
      pay('https://api.example/report', {
        wallet: { account: payAccount(), publicClient, walletClient },
        policy: { mode: 'auto', allowApproval: true },
        fetch,
      }),
    ).rejects.toThrow(/permit2Spender is missing/)

    expect(writeCalls).toEqual([]) // no approve broadcast
    expect(calls).toEqual(['probe']) // never retried
  })

  test('a reverted hash transfer → PaymentSideEffectError with txHash, no credential', async () => {
    const wwwAuth = Challenge.serialize(challengeWith(['hash']))
    const { publicClient, walletClient, writeCalls } = payClients({ receiptStatus: 'reverted' })
    const { fetch, calls } = payFetch(wwwAuth, { status: 200, receipt: 'r' })

    const err = await pay('https://api.example/report', {
      wallet: { account: payAccount(), publicClient, walletClient },
      fetch,
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(PaymentSideEffectError)
    const e = err as PaymentSideEffectError
    expect(e.route.id).toBe('mpp:hash')
    expect(e.txHash).toBe(VALID_TXHASH)
    expect(e.credential).toBeUndefined() // never got to build the credential
    expect(writeCalls).toEqual(['transfer']) // it DID broadcast
    expect(calls).toEqual(['probe']) // never retried
  })

  test('a hash receipt timeout → PaymentSideEffectError carrying txHash + cause', async () => {
    const wwwAuth = Challenge.serialize(challengeWith(['hash']))
    const { publicClient, walletClient, writeCalls } = payClients({ receiptThrows: true })
    const { fetch } = payFetch(wwwAuth, { status: 200, receipt: 'r' })

    const err = await pay('https://api.example/report', {
      wallet: { account: payAccount(), publicClient, walletClient },
      fetch,
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(PaymentSideEffectError)
    const e = err as PaymentSideEffectError
    expect(e.txHash).toBe(VALID_TXHASH)
    expect(e.cause).toBeInstanceOf(Error)
    expect(writeCalls).toEqual(['transfer'])
  })

  test('a reverted permit2 approve → PaymentSideEffectError with approveTxHash', async () => {
    const wwwAuth = Challenge.serialize(permit2Challenge()) // has permit2Spender
    const { publicClient, walletClient, writeCalls } = payClients({
      allowance: 0n,
      receiptStatus: 'reverted',
    })
    const { fetch } = payFetch(wwwAuth, { status: 200, receipt: 'r' })

    const err = await pay('https://api.example/report', {
      wallet: { account: payAccount(), publicClient, walletClient },
      policy: { allowApproval: true },
      fetch,
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(PaymentSideEffectError)
    const e = err as PaymentSideEffectError
    expect(e.approveTxHash).toBe(VALID_TXHASH)
    expect(writeCalls).toEqual(['approve']) // approved (reverted); never built the credential
  })

  test('a retry fetch that THROWS → PaymentSideEffectError carrying the credential', async () => {
    const wwwAuth = Challenge.serialize(challengeWith(['hash']))
    const { publicClient, walletClient, writeCalls } = payClients()
    const fetchStub = (async (_url: string, init?: RequestInit) => {
      if (!init?.headers) {
        return new Response(null, { status: 402, headers: { 'WWW-Authenticate': wwwAuth } })
      }
      throw new Error('network down') // the paid retry fails to complete
    }) as unknown as typeof fetch

    const err = await pay('https://api.example/report', {
      wallet: { account: payAccount(), publicClient, walletClient },
      fetch: fetchStub,
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(PaymentSideEffectError)
    const e = err as PaymentSideEffectError
    expect(e.route.id).toBe('mpp:hash')
    expect(e.credential).toMatch(/^Payment /) // the caller can resubmit THIS
    expect(e.cause).toBeInstanceOf(Error)
    expect(writeCalls).toEqual(['transfer']) // hash broadcast BEFORE the failing retry
  })

  // An account whose signTypedData rejects (wallet prompt declined / RPC error).
  const rejectingAccount = () =>
    ({
      address: payAccount().address,
      type: 'local',
      async signTypedData() {
        throw new Error('user rejected the signature')
      },
      async signTransaction() {
        return '0x'
      },
    }) as never

  test('permit2 credential-build failure AFTER the approve → PaymentSideEffectError with approveTxHash', async () => {
    const wwwAuth = Challenge.serialize(permit2Challenge()) // has permit2Spender
    // allowance short → approve fires + confirms success, THEN signTypedData rejects.
    const { publicClient, walletClient, writeCalls } = payClients({ allowance: 0n })
    const { fetch } = payFetch(wwwAuth, { status: 200, receipt: 'r' })

    const err = await pay('https://api.example/report', {
      wallet: { account: rejectingAccount(), publicClient, walletClient },
      policy: { allowApproval: true },
      fetch,
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(PaymentSideEffectError)
    const e = err as PaymentSideEffectError
    expect(e.approveTxHash).toBe(VALID_TXHASH) // the on-chain allowance grant to reconcile
    expect(e.cause).toBeInstanceOf(Error)
    expect(writeCalls).toEqual(['approve']) // approved, then the sign failed
  })

  test('permit2 sign failure with NO approve → plain error (never a false PaymentSideEffectError)', async () => {
    const wwwAuth = Challenge.serialize(permit2Challenge())
    // allowance already sufficient → NO approve broadcast; signTypedData still rejects.
    const { publicClient, walletClient, writeCalls } = payClients({ allowance: BigInt(AMOUNT) })
    const { fetch } = payFetch(wwwAuth, { status: 200, receipt: 'r' })

    const err = await pay('https://api.example/report', {
      wallet: { account: rejectingAccount(), publicClient, walletClient },
      policy: { allowApproval: true },
      fetch,
    }).catch((e: unknown) => e)

    // Nothing irreversible happened — surface the original error, not a side-effect error.
    expect(err).not.toBeInstanceOf(PaymentSideEffectError)
    expect((err as Error).message).toMatch(/rejected/)
    expect(writeCalls).toEqual([]) // no approve
  })
})
