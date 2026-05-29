/**
 * Server factory (preflightCharge + charge) invariants (spec §10).
 *
 * All four verifier bodies are live (Hash / Transaction /
 * Permit2 / Authorization). Tests here focus on:
 *   - preflightCharge algorithm (curated resolve, splits collapse,
 *     Permit2 deployment probe, settlement signer requirement, sentinel
 *     token rejection, store production guard)
 *   - charge() factory output shape (defaults, transport auto-wire,
 *     request hook route-override guard, stableBinding)
 *   - verify hook routing — the accepted-types gate fires
 *     BEFORE the switch, then the switch dispatches to the live verifier
 *     for that payload.type. Hash routing exercises the real verifier
 *     with a stub publicClient; routing tests for permit2 / transaction /
 *     authorization live in the per-verifier test files (src/server/
 *     {Permit2,Transaction,Authorization}.test.ts).
 */

import { Challenge } from 'mppx'
import type { PublicClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { preflightChargeForTest } from '../../test/helpers/server/preflightChargeForTest.js'
import { type ServerParameters, charge, chargeAsync } from './Charge.js'

const PK = '0x0101010101010101010101010101010101010101010101010101010101010101' as const
const SETTLEMENT = privateKeyToAccount(PK)
const RECIPIENT = '0x2222222222222222222222222222222222222222' as const

const baseParams = (overrides: Partial<ServerParameters> = {}): ServerParameters => ({
  chain: 'ethereum',
  token: 'USDC',
  recipient: RECIPIENT,
  credentialTypes: ['transaction', 'hash'],
  challengeBinding: { mode: 'mppx-hmac', secretKey: 'test-secret' },
  ...overrides,
})

const happy = (overrides: Partial<ServerParameters> = {}) =>
  preflightChargeForTest(baseParams(overrides), { mockedIsContractDeployed: () => true })

/* -------------------------------------------------------------------------- */
/*  Happy path                                                                */
/* -------------------------------------------------------------------------- */

describe('preflightCharge happy path', () => {
  test('resolves _resolved with curated values', async () => {
    const result = await happy()
    expect(result._resolved.currency).toBe('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')
    expect(result._resolved.decimals).toBe(6)
    expect(result._resolved.chainId).toBe(1)
    expect(result._resolved.permit2Address).toBe('0x000000000022d473030f116ddee9f6b43ac78ba3')
    expect(result._resolved.resolvedCredentialTypes).toEqual(['transaction', 'hash'])
  })

  test('resolves publicClient / transportUrl / viemChain', async () => {
    const result = await happy()
    expect(result._resolved.publicClient).toBeTruthy()
    expect(result._resolved.viemChain.id).toBe(1)
  })

  test('resolves store default to Store.memory() when omitted', async () => {
    const result = await happy()
    expect(result._resolved.store).toBeTruthy()
  })

  test('resolves settlementSigner from settlementAccount when needed', async () => {
    const result = await happy({
      credentialTypes: ['permit2'],
      settlementAccount: SETTLEMENT,
    })
    expect(result._resolved.settlementSigner).toBeTruthy()
    expect(result._resolved.settlementSigner?.account?.address).toBe(SETTLEMENT.address)
  })

  test('returns undefined settlementSigner for transaction/hash-only', async () => {
    const result = await happy()
    expect(result._resolved.settlementSigner).toBeUndefined()
  })
})

/* -------------------------------------------------------------------------- */
/*  Guards                                                                    */
/* -------------------------------------------------------------------------- */

describe('preflightCharge guards', () => {
  test('rejects credentialTypes empty array', async () => {
    await expect(happy({ credentialTypes: [] })).rejects.toThrow(/credentialTypes.*empty/)
  })

  // Confirmations validation. Previously a -1 value silently
  // bypassed the Hash/Transaction confirmation check (txConfirmations <
  // BigInt(-1) ≡ false). NaN / fractional values threw raw RangeError
  // inside the verifier hot path. Validate at the boundary instead.
  describe('confirmations validation', () => {
    test('rejects negative confirmations (would bypass the < check)', async () => {
      await expect(happy({ confirmations: -1 })).rejects.toThrow(
        /params\.confirmations must be a non-negative safe integer/,
      )
    })

    test('rejects fractional confirmations (BigInt would throw RangeError downstream)', async () => {
      await expect(happy({ confirmations: 1.5 })).rejects.toThrow(
        /params\.confirmations must be a non-negative safe integer/,
      )
    })

    test('rejects NaN confirmations', async () => {
      await expect(happy({ confirmations: Number.NaN })).rejects.toThrow(
        /params\.confirmations must be a non-negative safe integer/,
      )
    })

    test('rejects beyond MAX_SAFE_INTEGER (Number.isInteger lies above 2^53)', async () => {
      await expect(happy({ confirmations: Number.MAX_SAFE_INTEGER + 2 })).rejects.toThrow(
        /params\.confirmations must be a non-negative safe integer/,
      )
    })

    test('accepts 0 (immediate finality)', async () => {
      const result = await happy({ confirmations: 0 })
      expect(result._resolved.confirmations).toBe(0)
    })

    test('accepts undefined (falls back to curated default)', async () => {
      const result = await happy()
      // ethereum's curated default is 12
      expect(result._resolved.confirmations).toBe(12)
    })
  })

  // hashFromPolicy validation. Previously a typo (e.g. 'strict'
  // instead of 'strict_from') silently fell through to lax_from behavior
  // — disabling the source-binding security check (spec §8.4) without
  // any indication. Reject at the boundary.
  describe('hashFromPolicy validation', () => {
    test("rejects typo 'strict' (previously degraded silently to lax_from)", async () => {
      await expect(
        // Runtime bypass — typescript would reject this at compile but
        // a `params` blob from JSON / API gateway could carry it.
        happy({ hashFromPolicy: 'strict' as 'strict_from' }),
      ).rejects.toThrow(/hashFromPolicy must be 'strict_from' \| 'lax_from'/)
    })

    test('rejects arbitrary string', async () => {
      await expect(happy({ hashFromPolicy: 'whatever' as 'strict_from' })).rejects.toThrow(
        /hashFromPolicy must be 'strict_from' \| 'lax_from'/,
      )
    })

    test("accepts 'strict_from'", async () => {
      const result = await happy({ hashFromPolicy: 'strict_from' })
      expect(result.hashFromPolicy).toBe('strict_from')
    })

    test("accepts 'lax_from'", async () => {
      const result = await happy({ hashFromPolicy: 'lax_from' })
      expect(result.hashFromPolicy).toBe('lax_from')
    })

    test('accepts undefined (falls back to lax_from at verifier)', async () => {
      const result = await happy()
      expect(result.hashFromPolicy).toBeUndefined()
    })
  })

  test('rejects chainOverride.id != selected preset chainId', async () => {
    await expect(
      happy({ chainOverride: mainnet, chain: 'bsc', token: 'BINANCE_PEG_USDT' }),
    ).rejects.toThrow(/chainOverride\.id.*must equal/i)
  })

  test('rejects authorization on (chain, token) where matrix.eip3009Supported=false', async () => {
    await expect(
      happy({
        chain: 'bsc',
        token: 'BINANCE_PEG_USDT',
        credentialTypes: ['authorization'],
        settlementAccount: SETTLEMENT,
      }),
    ).rejects.toThrow(/authorization.*not supported/i)
  })

  test('rejects credentialType outside curated allowlist', async () => {
    // bsc + BINANCE_PEG_USDT has no authorization; force it.
    await expect(
      happy({
        chain: 'bsc',
        token: 'BINANCE_PEG_USDT',
        credentialTypes: ['authorization'],
        settlementAccount: SETTLEMENT,
      }),
    ).rejects.toThrow()
  })

  test('rejects permit2/authorization without settlement signer', async () => {
    await expect(happy({ credentialTypes: ['permit2'] })).rejects.toThrow(
      /settlementAccount.*settlementWalletClient/i,
    )
  })

  test('rejects Permit2 not deployed when user explicitly required permit2', async () => {
    await expect(
      preflightChargeForTest(
        baseParams({ credentialTypes: ['permit2'], settlementAccount: SETTLEMENT }),
        { mockedIsContractDeployed: () => false },
      ),
    ).rejects.toThrow(/Permit2 not deployed/i)
  })

  test('silently drops permit2 from resolved set when only base default included it', async () => {
    // No explicit credentialTypes → base default includes 'permit2'.
    // Mock probe returns false → permit2 should be removed silently.
    // exactOptionalPropertyTypes forbids `credentialTypes: undefined`, so build
    // the params without ever introducing the key.
    const result = await preflightChargeForTest(
      {
        chain: 'ethereum',
        token: 'USDC',
        recipient: RECIPIENT,
        settlementAccount: SETTLEMENT,
        challengeBinding: { mode: 'mppx-hmac', secretKey: 'test-secret' },
      },
      { mockedIsContractDeployed: () => false },
    )
    expect(result._resolved.resolvedCredentialTypes).not.toContain('permit2')
    expect(result._resolved.resolvedCredentialTypes).toContain('transaction')
    expect(result._resolved.resolvedCredentialTypes).toContain('hash')
  })

  test('rejects sentinel zero-address curated token (TEST_USDT bsc-testnet placeholder)', async () => {
    // TEST_USDT on bsc-testnet still carries the sentinel 0x000...000 in
    // curated.ts pending real contract pinning. preflight MUST reject so
    // zero-address `currency` never goes on the wire.
    await expect(
      preflightChargeForTest(
        {
          chain: 'bsc-testnet',
          token: 'TEST_USDT',
          recipient: RECIPIENT,
          credentialTypes: ['transaction', 'hash'],
          challengeBinding: { mode: 'mppx-hmac', secretKey: 'test-secret' },
        },
        { mockedIsContractDeployed: () => true },
      ),
    ).rejects.toThrow(/sentinel zero address/)
  })

  test('allowSentinelTokenAddress hook bypasses the sentinel check (live-test seam)', async () => {
    // Live-test scaffolds use this seam to point at not-yet-pinned curated
    // entries behind real testnet RPC. Without the seam, the rejection
    // above is the last guard.
    const result = await preflightChargeForTest(
      {
        chain: 'bsc-testnet',
        token: 'TEST_USDT',
        recipient: RECIPIENT,
        credentialTypes: ['transaction', 'hash'],
        challengeBinding: { mode: 'mppx-hmac', secretKey: 'test-secret' },
      },
      { mockedIsContractDeployed: () => true, allowSentinelTokenAddress: true },
    )
    expect(result._resolved.currency).toBe('0x0000000000000000000000000000000000000000')
  })

  test('rejects splits with non-permit2 credentialTypes', async () => {
    await expect(
      happy({
        credentialTypes: ['permit2', 'hash'],
        splits: [{ recipient: '0x3333333333333333333333333333333333333333', amount: '100000' }],
        settlementAccount: SETTLEMENT,
      }),
    ).rejects.toThrow(/splits require credentialTypes to be exactly/i)
  })

  test('splits collapses resolvedCredentialTypes to [permit2]', async () => {
    // No explicit credentialTypes — splits forces the collapse to ['permit2'].
    const result = await preflightChargeForTest(
      {
        chain: 'ethereum',
        token: 'USDC',
        recipient: RECIPIENT,
        splits: [{ recipient: '0x3333333333333333333333333333333333333333', amount: '100000' }],
        settlementAccount: SETTLEMENT,
        challengeBinding: { mode: 'mppx-hmac', secretKey: 'test-secret' },
      },
      { mockedIsContractDeployed: () => true },
    )
    expect(result._resolved.resolvedCredentialTypes).toEqual(['permit2'])
  })
})

/* -------------------------------------------------------------------------- */
/*  charge() factory wiring                                                   */
/* -------------------------------------------------------------------------- */

describe('charge(prepared) factory output', () => {
  test('returns a Method.Server with name=evm and intent=charge', async () => {
    const server = charge(await happy())
    expect(server.name).toBe('evm')
    expect(server.intent).toBe('charge')
  })

  test('defaults include curated currency + recipient + REQUIRED methodDetails', async () => {
    const server = charge(await happy())
    const defaults = server.defaults as Record<string, unknown>
    expect(defaults.currency).toBe('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')
    expect(defaults.recipient).toBe(RECIPIENT)
    const md = defaults.methodDetails as Record<string, unknown>
    expect(md.chainId).toBe(1)
    expect(md.permit2Address).toBe('0x000000000022d473030f116ddee9f6b43ac78ba3')
  })

  test('ships evmHttpTransport as per-method transport override (spec §13.4.1 C2 auto-wire)', async () => {
    const server = charge(await happy())
    // evmHttpTransport names itself 'evm-http' so deployment + debugging tools
    // can distinguish it from mppx's default Transport.http (name='http').
    expect(server.transport).toBeTruthy()
    expect((server.transport as { name?: string }).name).toBe('evm-http')
  })

  test('request hook rejects route currency override (spec §14.10)', async () => {
    const server = charge(await happy())
    const requestHook = server.request!
    // Server-configured currency is USDC (0xa0b8...eb48). Route attempts
    // to swap to a different token → request hook throws.
    const tampered = {
      amount: '1000000',
      currency: '0xdac17f958d2ee523a2206206994597c13d831ec7' as `0x${string}`, // USDT
      recipient: RECIPIENT,
      methodDetails: {
        chainId: 1,
        permit2Address: '0x000000000022d473030f116ddee9f6b43ac78ba3' as `0x${string}`,
      },
    }
    expect(() => requestHook({ request: tampered as never })).toThrow(
      /'currency'.*cannot override/i,
    )
  })

  test('request hook rejects route methodDetails.permit2Address override', async () => {
    const server = charge(await happy())
    const tampered = {
      amount: '1000000',
      currency: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as `0x${string}`,
      recipient: RECIPIENT,
      methodDetails: {
        chainId: 1,
        permit2Address: '0x9999999999999999999999999999999999999999' as `0x${string}`,
      },
    }
    expect(() => server.request!({ request: tampered as never })).toThrow(
      /'methodDetails.permit2Address'.*cannot override/i,
    )
  })

  test('request hook rejects route methodDetails.credentialTypes override', async () => {
    const server = charge(await happy())
    const tampered = {
      amount: '1000000',
      currency: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as `0x${string}`,
      recipient: RECIPIENT,
      methodDetails: {
        chainId: 1,
        permit2Address: '0x000000000022d473030f116ddee9f6b43ac78ba3' as `0x${string}`,
        // Server resolved ['transaction','hash']; route tries 'permit2'
        credentialTypes: ['permit2'],
      },
    }
    expect(() => server.request!({ request: tampered as never })).toThrow(
      /'methodDetails.credentialTypes'.*cannot override/i,
    )
  })

  test('request hook rejects route credentialTypes REORDERED (same set, different order)', async () => {
    // Server resolved order is ['transaction','hash'] (from baseParams).
    // Route attempts ['hash','transaction'] — same set, swapped order.
    // Per draft Table 2 the order is a client preference signal; allowing
    // reorder would let a route change the client's first-pick credential
    // type. credentialTypes comparison MUST be order-sensitive.
    const server = charge(await happy())
    const reordered = {
      amount: '1000000',
      currency: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as `0x${string}`,
      recipient: RECIPIENT,
      methodDetails: {
        chainId: 1,
        permit2Address: '0x000000000022d473030f116ddee9f6b43ac78ba3' as `0x${string}`,
        credentialTypes: ['hash', 'transaction'], // reversed
      },
    }
    expect(() => server.request!({ request: reordered as never })).toThrow(
      /'methodDetails.credentialTypes'.*mismatch incl. ordering/i,
    )
  })

  test('request hook allows amount + description + externalId to vary (omit methodDetails)', async () => {
    // Partial-methodDetails guard: route MUST either omit
    // methodDetails entirely (defaults apply intact) OR provide every
    // server-protected field. The "vary per-route" path uses option A
    // — route options carry only the per-call fields.
    const server = charge(await happy())
    const allowedRoute = {
      amount: '5000000', // varies per route — fine
      currency: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as `0x${string}`,
      recipient: RECIPIENT,
      description: 'Order #42',
      externalId: 'route-specific-order-id',
      // methodDetails OMITTED — defaults from server factory inject the
      // full set (chainId, permit2Address, credentialTypes, decimals).
    }
    expect(() => server.request!({ request: allowedRoute as never })).not.toThrow()
  })

  test('rejects PARTIAL methodDetails (silent shallow-merge would drop credentialTypes/decimals)', async () => {
    // The bug this plugs: mppx merges request shallowly, so a route
    // option that passes ANY methodDetails replaces defaults.methodDetails
    // wholesale. The earlier present-field checks let this slip through,
    // and the wire challenge silently lost credentialTypes/decimals/splits
    // — which the client check then correctly rejected downstream.
    // Now the request hook itself rejects partial methodDetails up-front.
    const server = charge(await happy())
    const partialMd = {
      amount: '1000000',
      methodDetails: {
        chainId: 1,
        permit2Address: '0x000000000022d473030f116ddee9f6b43ac78ba3' as `0x${string}`,
        // missing credentialTypes + decimals — intentionally partial
      },
    }
    expect(() => server.request!({ request: partialMd as never })).toThrow(
      /partial.*missing.*\[credentialTypes, decimals\]/i,
    )
  })

  test('accepts methodDetails when every protected field is present and matches', async () => {
    // The "provide every protected field" path: route options can repeat
    // the server-resolved methodDetails (e.g. for clarity / explicit
    // contract calls) as long as every value matches.
    const server = charge(await happy())
    const fullMatchingMd = {
      amount: '1000000',
      methodDetails: {
        chainId: 1,
        permit2Address: '0x000000000022d473030f116ddee9f6b43ac78ba3' as `0x${string}`,
        credentialTypes: ['transaction', 'hash'] as const, // matches happy() defaults
        decimals: 6, // matches happy() defaults (USDC)
      },
    }
    expect(() => server.request!({ request: fullMatchingMd as never })).not.toThrow()
  })

  test('stableBinding pins full EVM methodDetails (spec §14.10)', async () => {
    const server = charge(await happy())
    const fullReq = {
      amount: '1000000',
      currency: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as `0x${string}`,
      recipient: RECIPIENT,
      methodDetails: {
        chainId: 1,
        permit2Address: '0x000000000022d473030f116ddee9f6b43ac78ba3' as `0x${string}`,
        // Settlement signer that signs Permit2 typed-data as `spender`.
        // MUST flow into the HMAC binding — a tampered challenge that
        // swaps the spender (keeping the same id) would redirect the
        // user's signed authorization to an attacker-controlled relayer.
        permit2Spender: '0x5555555555555555555555555555555555555555' as `0x${string}`,
        credentialTypes: ['transaction', 'hash'] as const,
        decimals: 6,
      },
    }
    const bound = server.stableBinding!(fullReq as never) as {
      methodDetails: Record<string, unknown>
    }
    // permit2Address / permit2Spender / credentialTypes / decimals MUST be
    // in the binding — mppx default only pins chainId + splits.
    expect(bound.methodDetails.permit2Address).toBe('0x000000000022d473030f116ddee9f6b43ac78ba3')
    expect(bound.methodDetails.permit2Spender).toBe('0x5555555555555555555555555555555555555555')
    expect(bound.methodDetails.credentialTypes).toEqual(['transaction', 'hash'])
    expect(bound.methodDetails.decimals).toBe(6)
  })

  test('verify hook routes hash credential to verifyHash', async () => {
    // The hash route runs the real verifier — which calls
    // publicClient.getTransactionReceipt. Inject a stub that returns
    // a happy receipt with a matching Transfer log; verify it succeeds and
    // produces an EvmReceipt with the routed challengeId.
    const TX = '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789' as const
    const PAYER = '0x4444444444444444444444444444444444444444' as const

    // viem ABI for Transfer event (must match Hash.ts internal ABI).
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
    const { encodeAbiParameters, encodeEventTopics } = await import('viem')
    const transferLog = {
      address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      blockHash: `0x${'1'.repeat(64)}`,
      blockNumber: 100n,
      data: encodeAbiParameters([{ type: 'uint256' }], [1_000_000n]),
      logIndex: 0,
      removed: false,
      topics: encodeEventTopics({
        abi: TRANSFER_ABI,
        eventName: 'Transfer',
        args: { from: PAYER, to: RECIPIENT },
      }),
      transactionHash: TX,
      transactionIndex: 0,
    }
    const stubReceipt = {
      blockHash: `0x${'2'.repeat(64)}`,
      blockNumber: 100n,
      contractAddress: null,
      cumulativeGasUsed: 0n,
      effectiveGasPrice: 0n,
      from: PAYER,
      gasUsed: 0n,
      logs: [transferLog],
      logsBloom: '0x',
      status: 'success' as const,
      to: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      transactionHash: TX,
      transactionIndex: 0,
      type: 'eip1559' as const,
    }
    const stubClient = {
      async getTransactionReceipt() {
        return stubReceipt
      },
      async getBlockNumber() {
        // ethereum's curated default confirmations is 12; receipt is at
        // block 100 so latest must be ≥ 111 for the check to pass.
        return 200n
      },
    } as unknown as PublicClient

    const prepared = await preflightChargeForTest(baseParams(), {
      mockedIsContractDeployed: () => true,
      publicClient: stubClient,
    })
    const server = charge(prepared)

    const out = await server.verify({
      credential: {
        challenge: makeChallenge(),
        payload: { type: 'hash', hash: TX },
      },
      request: {
        amount: '1000000',
        currency: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        recipient: RECIPIENT,
        methodDetails: {
          chainId: 1,
          permit2Address: '0x000000000022d473030f116ddee9f6b43ac78ba3',
        },
      },
    } as never)

    expect(out).toMatchObject({
      method: 'evm',
      status: 'success',
      reference: TX,
      chainId: 1,
      challengeId: expect.any(String),
    })
  })
})

/* -------------------------------------------------------------------------- */
/*  server verify gates by accepted credentialTypes BEFORE switch              */
/* -------------------------------------------------------------------------- */

describe('charge().verify accepted-types gate', () => {
  // Every test below pairs a `makeChallenge(...)` call whose
  // request.methodDetails EXACTLY MATCHES the verify-request — otherwise
  // mppx-hmac re-derives a different challenge.id and `verifyChallengeBinding`
  // throws "route request does not match challenge.request" BEFORE the
  // gate runs.

  test('rejects credential.payload.type not in challenge.credentialTypes', async () => {
    // Server configured for hash-only; client tries to submit a transaction
    // credential. An earlier approach routed to verifyTransaction regardless
    // of what the challenge advertised; the gate catches this BEFORE any
    // verifier body, RPC call, or store reserve.
    const prepared = await preflightChargeForTest(baseParams({ credentialTypes: ['hash'] }), {
      mockedIsContractDeployed: () => true,
    })
    const server = charge(prepared)

    const md = {
      chainId: 1,
      permit2Address: '0x000000000022d473030f116ddee9f6b43ac78ba3',
      credentialTypes: ['hash'],
    } as const
    const requestWithHashOnly = {
      amount: '1000000',
      currency: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      recipient: RECIPIENT,
      methodDetails: md,
    }
    await expect(
      server.verify({
        credential: {
          // Challenge.request.methodDetails MUST equal the verify-request's,
          // including the credentialTypes field — otherwise the HMAC binding
          // mismatches and the gate never runs.
          challenge: makeChallenge({ credentialTypes: ['hash'] }),
          payload: {
            type: 'transaction',
            signature: '0x02f8' + 'a'.repeat(200), // garbage tx; gate fires before parse
          },
        },
        request: requestWithHashOnly,
      } as never),
    ).rejects.toThrow(/'transaction' is not in challenge\.request\.methodDetails\.credentialTypes/)
  })

  test("default credentialTypes (omitted from request) only accepts ['transaction','hash']", async () => {
    // Spec §4.2.2 / §6.3: when methodDetails.credentialTypes is
    // absent in the wire request (the defense-in-depth case for a
    // tampered challenge that somehow elided the field), the server-side
    // accepted default is ['transaction', 'hash'] only. permit2 and
    // authorization MUST be explicitly advertised.
    //
    // Build the server with permit2 in `credentialTypes` so the factory
    // path would in principle accept it — but the wire CHALLENGE we
    // hand-craft below intentionally omits the credentialTypes field, so
    // the gate must still reject permit2 here. Previously this slipped through.
    const prepared = await preflightChargeForTest(
      baseParams({
        credentialTypes: ['permit2', 'transaction', 'hash'],
        settlementAccount: SETTLEMENT,
      }),
      { mockedIsContractDeployed: () => true },
    )
    const server = charge(prepared)

    // Both challenge.request.methodDetails AND the verify request OMIT
    // credentialTypes — they must match byte-for-byte so HMAC binding
    // passes and the gate sees the "credentialTypes absent" case.
    const requestWithoutCT = {
      amount: '1000000',
      currency: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      recipient: RECIPIENT,
      methodDetails: {
        chainId: 1,
        permit2Address: '0x000000000022d473030f116ddee9f6b43ac78ba3',
      },
    }
    await expect(
      server.verify({
        credential: {
          challenge: makeChallenge(), // no credentialTypes override → omitted
          payload: { type: 'permit2' } as never, // gate fires before payload validation
        },
        request: requestWithoutCT,
      } as never),
    ).rejects.toThrow(/'permit2' is not in.*transaction.*hash/)
  })

  test('splits-bearing challenge rejects non-permit2 payload (spec §4.2.3)', async () => {
    // Defense-in-depth for a tampered challenge that slipped a splits[]
    // field through HMAC / stored-lookup binding despite credentialTypes
    // not being ['permit2']. preflight + curated allowlist forbid this
    // combination at construction; the gate is the runtime second-line.
    //
    // Note we have to hand-craft the challenge directly (Challenge.from)
    // because the charge() factory's request hook would also reject this
    // combination at issuance. The test exercises the verify-side gate.
    const prepared = await preflightChargeForTest(baseParams({ credentialTypes: ['hash'] }), {
      mockedIsContractDeployed: () => true,
    })
    const server = charge(prepared)

    const splitsMd = {
      chainId: 1,
      permit2Address: '0x000000000022d473030f116ddee9f6b43ac78ba3',
      credentialTypes: ['hash'],
      splits: [
        {
          recipient: '0x3333333333333333333333333333333333333333',
          amount: '100000',
        },
      ],
    } as const
    const splittedRequest = {
      amount: '1000000',
      currency: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      recipient: RECIPIENT,
      methodDetails: splitsMd,
    }
    await expect(
      server.verify({
        credential: {
          // Challenge with the SAME splits + credentialTypes — HMAC binding
          // matches; the splits clause of the gate fires.
          challenge: makeChallenge({ credentialTypes: ['hash'], splits: splitsMd.splits }),
          payload: { type: 'hash', hash: `0x${'a'.repeat(64)}` },
        },
        request: splittedRequest,
      } as never),
    ).rejects.toThrow(/cannot fulfill a splits-bearing challenge/)
  })
})

/* -------------------------------------------------------------------------- */
/*  chargeAsync sugar                                                         */
/* -------------------------------------------------------------------------- */

describe('chargeAsync sugar', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  test('produces a server object with same shape as charge(await preflight(...))', async () => {
    // chargeAsync hits real preflight (no mock); use credentialTypes that
    // do NOT trigger Permit2 probe to keep it offline.
    const server = await chargeAsync(baseParams())
    expect(server.name).toBe('evm')
    expect(server.intent).toBe('charge')
  })
})

/* -------------------------------------------------------------------------- */
/*  Memory-store production guard — honest presence-only check                */
/* -------------------------------------------------------------------------- */

describe('preflightCharge store production guard', () => {
  const originalNodeEnv = process.env.NODE_ENV

  beforeEach(() => {
    process.env.NODE_ENV = originalNodeEnv
    vi.restoreAllMocks()
  })

  test('throws when params.store is omitted and NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production'
    try {
      await expect(happy()).rejects.toThrow(/params\.store is REQUIRED when NODE_ENV=production/)
    } finally {
      process.env.NODE_ENV = originalNodeEnv
    }
  })

  test('ANY explicitly-passed store passes under production (SDK trusts caller)', async () => {
    // An earlier approach tried to brand the auto-defaulted Store.memory() and reject
    // user-passed Store.memory() via the brand. That was a half-measure:
    // user code that did `params.store = Store.memory()` carried no brand
    // and slipped through. The current behavior acknowledges the SDK genuinely cannot
    // verify durability across the FFI boundary — anyone can wrap a Map
    // in a ChargeStore interface and call it "Redis". Honest behavior:
    // presence-only check, with docs that say "SDK trusts the supplied
    // store is durable".
    process.env.NODE_ENV = 'production'
    const { Store } = await import('mppx')
    try {
      const result = await preflightChargeForTest(
        baseParams({
          store: Store.memory() as NonNullable<ServerParameters['store']>,
        }),
        { mockedIsContractDeployed: () => true },
      )
      // The store passes through unchanged — SDK doesn't reject Store.memory()
      // even under production. The DEPLOYMENT is responsible for ensuring
      // the supplied store is actually durable.
      expect(result._resolved.store).toBeTruthy()
    } finally {
      process.env.NODE_ENV = originalNodeEnv
    }
  })

  test('warns (but resolves) when params.store is omitted and NODE_ENV=development', async () => {
    process.env.NODE_ENV = 'development'
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await happy()
      expect(result._resolved.store).toBeTruthy()
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/defaulting to Store\.memory\(\)/))
    } finally {
      warnSpy.mockRestore()
      process.env.NODE_ENV = originalNodeEnv
    }
  })

  test('warns when NODE_ENV is unset (treated like dev)', async () => {
    const saved = process.env.NODE_ENV
    delete process.env.NODE_ENV
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await happy()
      expect(result._resolved.store).toBeTruthy()
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
      if (saved !== undefined) process.env.NODE_ENV = saved
    }
  })

  test('silent under NODE_ENV=test (no log noise in test runs)', async () => {
    process.env.NODE_ENV = 'test'
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await happy()
      expect(result._resolved.store).toBeTruthy()
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
      process.env.NODE_ENV = originalNodeEnv
    }
  })
})

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Build a hand-crafted Challenge whose `request.methodDetails` matches the
 * verify-request the test will pass. mppx-hmac re-derives the HMAC
 * from the verify request and compares to challenge.id, so the two MUST
 * be byte-equal — otherwise `verifyChallengeBinding` throws BEFORE the
 * accepted-types gate (or any other verifier-body logic) runs.
 *
 * Uses Challenge.from directly so we bypass the charge() factory's
 * request hook (which would reject the partial / tampered methodDetails
 * shapes that some gate tests intentionally build to exercise defense
 * in depth).
 */
function makeChallenge(mdOverrides: Record<string, unknown> = {}) {
  return Challenge.from({
    method: 'evm',
    intent: 'charge',
    realm: 'https://api.example.com/',
    request: {
      amount: '1000000',
      currency: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      recipient: RECIPIENT,
      methodDetails: {
        chainId: 1,
        permit2Address: '0x000000000022d473030f116ddee9f6b43ac78ba3',
        ...mdOverrides,
      },
    } as never,
    expires: new Date(Date.now() + 60_000).toISOString(),
    secretKey: 'test-secret',
  })
}
