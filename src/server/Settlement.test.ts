/**
 * resolveSettlementSigner invariants (spec §10.2).
 *
 *   - account-only -> wraps in a fresh walletClient bound to ctx
 *   - walletClient-only -> used as-is (after guards)
 *   - both with matching addresses -> walletClient wins (precedence)
 *   - both with mismatched addresses -> SettlementConfigError
 *   - walletClient with chain.id != ctx.chainId -> SettlementConfigError
 *   - walletClient without account -> SettlementConfigError
 *   - neither set -> returns undefined (caller decides if that's fatal)
 */

import { type Account, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { bsc, mainnet } from 'viem/chains'
import { describe, expect, test } from 'vitest'

import { SettlementConfigError, resolveSettlementSigner } from './Settlement.js'

const PK_A = '0x0101010101010101010101010101010101010101010101010101010101010101' as const
const PK_B = '0x0202020202020202020202020202020202020202020202020202020202020202' as const

const accountA = privateKeyToAccount(PK_A)
const accountB = privateKeyToAccount(PK_B)

const ctxBsc = {
  viemChain: bsc,
  transportUrl: undefined,
  chainId: bsc.id,
} as const

describe('resolveSettlementSigner — account precedence', () => {
  test('settlementAccount-only wraps in a fresh WalletClient bound to ctx', () => {
    const wc = resolveSettlementSigner({ settlementAccount: accountA }, ctxBsc)
    expect(wc).toBeTruthy()
    expect(wc!.account?.address).toBe(accountA.address)
    expect(wc!.chain?.id).toBe(bsc.id)
  })

  test('settlementWalletClient-only is used as-is', () => {
    const provided = createWalletClient({ account: accountA, chain: bsc, transport: http() })
    const wc = resolveSettlementSigner({ settlementWalletClient: provided }, ctxBsc)
    expect(wc).toBe(provided)
  })

  test('both set with matching addresses -> walletClient wins', () => {
    const provided = createWalletClient({ account: accountA, chain: bsc, transport: http() })
    const wc = resolveSettlementSigner(
      { settlementAccount: accountA, settlementWalletClient: provided },
      ctxBsc,
    )
    expect(wc).toBe(provided)
  })

  test('neither set -> returns undefined', () => {
    expect(resolveSettlementSigner({}, ctxBsc)).toBeUndefined()
  })
})

describe('resolveSettlementSigner — sanity guards', () => {
  test('throws if walletClient has no account', () => {
    const provided = createWalletClient({ chain: bsc, transport: http() }) as unknown as {
      account?: Account
      chain?: typeof bsc
    }
    expect(() =>
      resolveSettlementSigner(
        { settlementWalletClient: provided as unknown as ReturnType<typeof createWalletClient> },
        ctxBsc,
      ),
    ).toThrow(SettlementConfigError)
  })

  test('throws if account and walletClient.account addresses mismatch', () => {
    const provided = createWalletClient({ account: accountB, chain: bsc, transport: http() })
    expect(() =>
      resolveSettlementSigner(
        { settlementAccount: accountA, settlementWalletClient: provided },
        ctxBsc,
      ),
    ).toThrow(/address.*must equal/i)
  })

  test('throws if walletClient.chain.id != ctx.chainId', () => {
    const provided = createWalletClient({ account: accountA, chain: mainnet, transport: http() })
    expect(() => resolveSettlementSigner({ settlementWalletClient: provided }, ctxBsc)).toThrow(
      /chain\.id.*must equal resolved chainId/i,
    )
  })

  test('accepts walletClient with no chain (chain check skipped)', () => {
    // http() with no URL + no chain throws "No URL was provided to the Transport"
    // — supply a stub URL so the WalletClient constructs.
    const provided = createWalletClient({
      account: accountA,
      transport: http('https://example.invalid/'),
    })
    const wc = resolveSettlementSigner({ settlementWalletClient: provided }, ctxBsc)
    expect(wc).toBe(provided)
  })

  test('SettlementConfigError carries name field', () => {
    try {
      const provided = createWalletClient({ account: accountB, chain: bsc, transport: http() })
      resolveSettlementSigner(
        { settlementAccount: accountA, settlementWalletClient: provided },
        ctxBsc,
      )
    } catch (e) {
      expect((e as Error).name).toBe('SettlementConfigError')
    }
  })
})

describe('resolveSettlementSigner — case-insensitive address compare (EIP-55)', () => {
  test('uppercase account address matches lowercase walletClient account', () => {
    const provided = createWalletClient({ account: accountA, chain: bsc, transport: http() })
    const upperCased: Account = {
      ...accountA,
      address: accountA.address.toUpperCase() as `0x${string}`,
    }
    const wc = resolveSettlementSigner(
      { settlementAccount: upperCased, settlementWalletClient: provided },
      ctxBsc,
    )
    expect(wc).toBe(provided)
  })
})
