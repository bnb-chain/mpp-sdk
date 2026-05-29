/**
 * Curated chain/token matrix invariants.
 *
 * Spec §5.2 / §5.3 hard rules verified here:
 *   1. Every SupportedChainPreset resolves to a viem Chain + chainId
 *   2. Token lookups throw on missing (chain, token) pairs — no silent fallback
 *   3. ('bsc', 'USDC') is NOT in the matrix (BSC has no Circle native USDC)
 *   4. ('ethereum', 'TEST_USDT') is NOT in the matrix (testnet-only preset)
 *   5. EIP-712 domain lookup throws on non-EIP-3009 tokens
 *   6. getAcceptedCredentialTypes prepends 'authorization' iff eip3009Supported
 */

import { describe, expect, test } from 'vitest'

import {
  CuratedLookupError,
  curatedDefaultConfirmations,
  curatedRpcUrl,
  curatedViemChain,
  getAcceptedCredentialTypes,
  getCuratedEip712Domain,
  isCuratedEip3009Supported,
  resolveCuratedChainId,
  resolveCuratedTokenAddress,
  resolveCuratedTokenDecimals,
  type SupportedChainPreset,
  type SupportedTokenPreset,
} from './curated.js'

/* -------------------------------------------------------------------------- */
/*  Chain resolution                                                          */
/* -------------------------------------------------------------------------- */

describe('chain resolvers', () => {
  test.each<[SupportedChainPreset, number]>([
    ['ethereum', 1],
    ['bsc', 56],
    ['opbnb', 204],
    ['base', 8453],
    ['arbitrum', 42161],
    ['optimism', 10],
    ['polygon', 137],
    ['avalanche', 43114],
    ['linea', 59144],
    ['sepolia', 11155111],
    ['bsc-testnet', 97],
    ['opbnb-testnet', 5611],
    ['base-sepolia', 84532],
    ['arbitrum-sepolia', 421614],
    ['optimism-sepolia', 11155420],
    ['polygon-amoy', 80002],
    ['avalanche-fuji', 43113],
    ['linea-sepolia', 59141],
  ])('%s resolves to chainId %i', (preset, expected) => {
    expect(resolveCuratedChainId(preset)).toBe(expected)
  })

  test('curatedViemChain returns viem Chain with matching id', () => {
    expect(curatedViemChain('bsc').id).toBe(56)
    expect(curatedViemChain('bsc-testnet').id).toBe(97)
  })

  test('curatedRpcUrl returns undefined when no SDK default (viem fallback applies)', () => {
    // No bundled RPC URLs are shipped — deployments override via ServerParameters.rpcUrl.
    expect(curatedRpcUrl('ethereum')).toBeUndefined()
  })

  test('curatedDefaultConfirmations reflects chain risk profile', () => {
    expect(curatedDefaultConfirmations('ethereum')).toBe(12)
    expect(curatedDefaultConfirmations('bsc')).toBe(3)
    expect(curatedDefaultConfirmations('base')).toBe(1)
    expect(curatedDefaultConfirmations('bsc-testnet')).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */
/*  Token matrix lookups                                                      */
/* -------------------------------------------------------------------------- */

describe('token matrix lookups', () => {
  test('resolveCuratedTokenAddress returns Circle USDC on ethereum', () => {
    expect(resolveCuratedTokenAddress('ethereum', 'USDC')).toBe(
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    )
  })

  test('resolveCuratedTokenAddress returns Binance-Peg USDT on bsc', () => {
    expect(resolveCuratedTokenAddress('bsc', 'BINANCE_PEG_USDT')).toBe(
      '0x55d398326f99059ff775485246999027b3197955',
    )
  })

  test('resolveCuratedTokenDecimals returns 6 for ethereum USDC', () => {
    expect(resolveCuratedTokenDecimals('ethereum', 'USDC')).toBe(6)
  })

  test('resolveCuratedTokenDecimals returns 18 for bsc BINANCE_PEG_USDT', () => {
    expect(resolveCuratedTokenDecimals('bsc', 'BINANCE_PEG_USDT')).toBe(18)
  })

  test('isCuratedEip3009Supported true for ethereum USDC, false for bsc BINANCE_PEG_USDT', () => {
    expect(isCuratedEip3009Supported('ethereum', 'USDC')).toBe(true)
    expect(isCuratedEip3009Supported('bsc', 'BINANCE_PEG_USDT')).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/*  Hard-rule exclusions                                                      */
/* -------------------------------------------------------------------------- */

describe('hard-rule exclusions', () => {
  test('(bsc, USDC) throws — BSC has no Circle native USDC (spec §5.3)', () => {
    expect(() => resolveCuratedTokenAddress('bsc', 'USDC')).toThrow(CuratedLookupError)
    expect(() => resolveCuratedTokenAddress('bsc', 'USDC')).toThrow(/bsc.*USDC.*not in.*curated/i)
  })

  test("(bsc, USDT) throws — migrated to 'BINANCE_PEG_USDT' (BSC has no native Tether)", () => {
    // The bridged Binance-Peg token lives under BINANCE_PEG_USDT now; the bare
    // 'USDT' alias on bsc is gone (it stays native-Tether-only, e.g. ethereum).
    expect(() => resolveCuratedTokenAddress('bsc', 'USDT')).toThrow(CuratedLookupError)
    expect(resolveCuratedTokenAddress('bsc', 'BINANCE_PEG_USDT')).toBe(
      '0x55d398326f99059ff775485246999027b3197955',
    )
  })

  test('(ethereum, TEST_USDT) throws — TEST_USDT is testnet-only', () => {
    expect(() => resolveCuratedTokenAddress('ethereum', 'TEST_USDT')).toThrow(CuratedLookupError)
  })

  test('(mainnet-chain, TEST_USDT) throws for every mainnet preset', () => {
    const mainnetChains: SupportedChainPreset[] = [
      'ethereum',
      'base',
      'arbitrum',
      'optimism',
      'polygon',
      'avalanche',
      'linea',
      'bsc',
      'opbnb',
    ]
    for (const chain of mainnetChains) {
      expect(() => resolveCuratedTokenAddress(chain, 'TEST_USDT')).toThrow(CuratedLookupError)
    }
  })

  test('CuratedLookupError carries diagnostic message', () => {
    try {
      resolveCuratedTokenAddress('bsc', 'USDC')
    } catch (e) {
      expect(e).toBeInstanceOf(CuratedLookupError)
      expect((e as Error).message).toMatch(/explorer-verified address/i)
    }
  })
})

/* -------------------------------------------------------------------------- */
/*  EIP-712 domain                                                            */
/* -------------------------------------------------------------------------- */

describe('EIP-712 domain', () => {
  test('returns Circle USDC domain on ethereum', () => {
    expect(getCuratedEip712Domain('ethereum', 'USDC')).toEqual({ name: 'USD Coin', version: '2' })
  })

  // BSC mainnet EIP-3009 tokens — domains derived by brute-forcing the
  // on-chain DOMAIN_SEPARATOR() return value (2026-05-28 probes). Any drift
  // here means the verifyAuthorization sig recovery will fail signature
  // verification for the affected token; lock the contract under test.
  test('returns First Digital USD domain on bsc/FDUSD', () => {
    expect(getCuratedEip712Domain('bsc', 'FDUSD')).toEqual({
      name: 'First Digital USD',
      version: '1',
    })
  })

  test('returns United Stables domain on bsc/U', () => {
    expect(getCuratedEip712Domain('bsc', 'U')).toEqual({ name: 'United Stables', version: '1' })
  })

  test('throws on non-EIP-3009 token', () => {
    expect(() => getCuratedEip712Domain('ethereum', 'USDT')).toThrow(CuratedLookupError)
    expect(() => getCuratedEip712Domain('bsc', 'BINANCE_PEG_USDT')).toThrow(CuratedLookupError)
  })
})

/* -------------------------------------------------------------------------- */
/*  BSC FDUSD / U — entry shape lock                                          */
/* -------------------------------------------------------------------------- */

describe('bsc/FDUSD and bsc/U entries', () => {
  test('bsc/FDUSD address + decimals + EIP-3009 flag', () => {
    expect(resolveCuratedTokenAddress('bsc', 'FDUSD')).toBe(
      '0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409',
    )
    expect(resolveCuratedTokenDecimals('bsc', 'FDUSD')).toBe(18)
    expect(isCuratedEip3009Supported('bsc', 'FDUSD')).toBe(true)
  })

  test('bsc/U address + decimals + EIP-3009 flag', () => {
    expect(resolveCuratedTokenAddress('bsc', 'U')).toBe(
      '0xcE24439F2D9C6a2289F741120FE202248B666666',
    )
    expect(resolveCuratedTokenDecimals('bsc', 'U')).toBe(18)
    expect(isCuratedEip3009Supported('bsc', 'U')).toBe(true)
  })

  test('bsc/FDUSD accepted types start with authorization (EIP-3009)', () => {
    expect(getAcceptedCredentialTypes('bsc', 'FDUSD')).toEqual([
      'authorization',
      'permit2',
      'transaction',
      'hash',
    ])
  })

  test('bsc/U accepted types start with authorization (EIP-3009)', () => {
    expect(getAcceptedCredentialTypes('bsc', 'U')).toEqual([
      'authorization',
      'permit2',
      'transaction',
      'hash',
    ])
  })

  // BSC testnet $U sibling (0x2Ae9...0a66) does NOT implement EIP-3009 —
  // the testnet sibling contract reverts on transferWithAuthorization with
  // "Contract does not have fallback nor receive functions". Lock the
  // matrix to ensure no one accidentally adds ('bsc-testnet', 'U') with
  // eip3009Supported: true and ships a credential type that can't settle.
  test("('bsc-testnet', 'U') is NOT in the matrix", () => {
    expect(() => resolveCuratedTokenAddress('bsc-testnet', 'U')).toThrow(CuratedLookupError)
  })
})

/* -------------------------------------------------------------------------- */
/*  getAcceptedCredentialTypes                                                */
/* -------------------------------------------------------------------------- */

describe('getAcceptedCredentialTypes', () => {
  test('ethereum + USDC includes authorization (EIP-3009 supported)', () => {
    const types = getAcceptedCredentialTypes('ethereum', 'USDC')
    expect(types).toContain('authorization')
    expect(types).toContain('permit2')
    expect(types).toContain('transaction')
    expect(types).toContain('hash')
  })

  test('bsc + BINANCE_PEG_USDT excludes authorization (EIP-3009 not supported)', () => {
    const types = getAcceptedCredentialTypes('bsc', 'BINANCE_PEG_USDT')
    expect(types).not.toContain('authorization')
    expect(types).toContain('permit2')
    expect(types).toContain('transaction')
    expect(types).toContain('hash')
  })

  test('always includes transaction + hash (draft §4.2.2 MUST/SHOULD)', () => {
    const types = getAcceptedCredentialTypes('bsc', 'BINANCE_PEG_USDT')
    expect(types).toContain('transaction')
    expect(types).toContain('hash')
  })

  test('throws on missing (chain, token) pair', () => {
    expect(() => getAcceptedCredentialTypes('bsc', 'USDC' as SupportedTokenPreset)).toThrow(
      CuratedLookupError,
    )
  })

  /* ------------------------------------------------------------------------ */
  /*  Order is semantic                                                       */
  /* ------------------------------------------------------------------------ */

  // The returned array is a draft Table 2 ordered preference list. The
  // request hook in src/server/Charge.ts rejects route options that
  // reorder credentialTypes (verified in Charge.test.ts), so the order
  // here is normative — downstream MUST NOT shuffle / sort.

  test('EIP-3009 token order: authorization first, then permit2 / transaction / hash', () => {
    // ethereum/USDC is the canonical EIP-3009 token in the matrix.
    expect(getAcceptedCredentialTypes('ethereum', 'USDC')).toEqual([
      'authorization',
      'permit2',
      'transaction',
      'hash',
    ])
    // base/USDC mirrors ethereum/USDC (Circle native, EIP-3009).
    expect(getAcceptedCredentialTypes('base', 'USDC')).toEqual([
      'authorization',
      'permit2',
      'transaction',
      'hash',
    ])
  })

  test('non-EIP-3009 token order: permit2 first, then transaction / hash', () => {
    // bsc/BINANCE_PEG_USDT (Binance-Peg, no EIP-3009).
    expect(getAcceptedCredentialTypes('bsc', 'BINANCE_PEG_USDT')).toEqual([
      'permit2',
      'transaction',
      'hash',
    ])
    // ethereum/USDT (mainnet Tether, no EIP-3009).
    expect(getAcceptedCredentialTypes('ethereum', 'USDT')).toEqual([
      'permit2',
      'transaction',
      'hash',
    ])
    // bsc-testnet/TEST_USDT testnet entry, no EIP-3009.
    expect(getAcceptedCredentialTypes('bsc-testnet', 'TEST_USDT')).toEqual([
      'permit2',
      'transaction',
      'hash',
    ])
  })

  test('returned array is mutable but the caller MUST treat it as ordered', () => {
    // We return a plain CredentialType[] (the type signature says
    // readonly to communicate "don't mutate", but TypeScript erases
    // readonly at runtime). The Charge.ts request hook uses ordered
    // JSON.stringify equality — any reorder would be rejected when a
    // route override carries a different sequence. This test locks the
    // ordering contract; do NOT "fix" it by sorting.
    const types = getAcceptedCredentialTypes('ethereum', 'USDC')
    const reordered = [...types].sort()
    expect(JSON.stringify(types)).not.toEqual(JSON.stringify(reordered))
  })
})

/* -------------------------------------------------------------------------- */
/*  v1 matrix expansion — issuer-verified, EIP-3009 probe-gated               */
/* -------------------------------------------------------------------------- */

// Every entry added in the stablecoin-coverage expansion. Addresses + decimals
// come from issuer official pages (Circle / PayPal / Paxos / Tether / First
// Digital). All ship eip3009Supported: false — `authorization` stays OFF until
// a per-chain transferWithAuthorization + DOMAIN_SEPARATOR probe locks the
// exact EIP-712 domain. This block locks the matrix shape so an accidental
// edit (wrong address/decimals, or flipping EIP-3009 on without a domain)
// fails the suite.
describe('v1 matrix expansion (eip3009 probe-gated)', () => {
  const NEW_ENTRIES: Array<[SupportedChainPreset, SupportedTokenPreset, string, number]> = [
    // Circle native USDC — new mainnets
    ['arbitrum', 'USDC', '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 6],
    ['optimism', 'USDC', '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 6],
    ['polygon', 'USDC', '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', 6],
    ['avalanche', 'USDC', '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', 6],
    ['linea', 'USDC', '0x176211869cA2b568f2A7D4EE941E073a821EE1ff', 6],
    // Circle native USDC — testnets
    ['base-sepolia', 'USDC', '0x036CbD53842c5426634e7929541eC2318f3dCF7e', 6],
    ['arbitrum-sepolia', 'USDC', '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', 6],
    ['optimism-sepolia', 'USDC', '0x5fd84259d66Cd46123540766Be93DFE6D43130D7', 6],
    ['polygon-amoy', 'USDC', '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582', 6],
    ['avalanche-fuji', 'USDC', '0x5425890298aed601595a70AB815c96711a31Bc65', 6],
    ['linea-sepolia', 'USDC', '0xFEce4462D57bD51A6A552365A011b95f0E16d9B7', 6],
    // Circle EURC
    ['ethereum', 'EURC', '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c', 6],
    ['base', 'EURC', '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42', 6],
    ['avalanche', 'EURC', '0xC891EB4cbdEFf6e073e859e987815Ed1505c2ACD', 6],
    ['sepolia', 'EURC', '0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4', 6],
    ['base-sepolia', 'EURC', '0x808456652fdb597867f38412077A9182bf77359F', 6],
    ['avalanche-fuji', 'EURC', '0x5E44db7996c682E92a960b65AC713a54AD815c6B', 6],
    // PayPal USD (Paxos)
    ['ethereum', 'PYUSD', '0x6c3ea9036406852006290770BEdFcAbA0e23A0e8', 18],
    ['arbitrum', 'PYUSD', '0x46850aD61C2B7d64d08c9C754F45254596696984', 18],
    ['sepolia', 'PYUSD', '0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9', 18],
    ['arbitrum-sepolia', 'PYUSD', '0x637A1259C6afd7E3AdF63993cA7E58BB438aB1B1', 18],
    // Paxos USDP / USDG
    ['ethereum', 'USDP', '0x8E870D67F660D95d5be530380D0eC0bd388289E1', 18],
    ['ethereum', 'USDG', '0xe343167631d89B6Ffc58B88d6b7fB0228795491D', 6],
    // First Digital USD
    ['ethereum', 'FDUSD', '0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409', 18],
    ['arbitrum', 'FDUSD', '0x93C9932E4afa59201F0B5E63f7d816516F1669fE', 18],
    // Tether USD₮ (Avalanche only — not the bridged L2 variants)
    ['avalanche', 'USDT', '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', 6],
    // BSC Binance-Peg (bridged — distinct preset name, never native 'USDC';
    // 18 decimals, NOT the 6 of Circle-native USDC)
    ['bsc', 'BINANCE_PEG_USDC', '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 18],
    ['bsc', 'BINANCE_PEG_DAI', '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3', 18],
  ]

  test.each(NEW_ENTRIES)(
    '%s/%s → address, decimals %i, authorization OFF (eip3009 probe-gated)',
    (chain, token, address, decimals) => {
      expect(resolveCuratedTokenAddress(chain, token)).toBe(address)
      expect(resolveCuratedTokenDecimals(chain, token)).toBe(decimals)
      // eip3009 deliberately false → no authorization, no EIP-712 domain.
      expect(isCuratedEip3009Supported(chain, token)).toBe(false)
      expect(getAcceptedCredentialTypes(chain, token)).toEqual(['permit2', 'transaction', 'hash'])
      expect(() => getCuratedEip712Domain(chain, token)).toThrow(CuratedLookupError)
    },
  )

  test('new token presets (PYUSD / USDP / USDG) resolve in the matrix', () => {
    expect(resolveCuratedTokenDecimals('ethereum', 'PYUSD')).toBe(18)
    expect(resolveCuratedTokenDecimals('ethereum', 'USDP')).toBe(18)
    expect(resolveCuratedTokenDecimals('ethereum', 'USDG')).toBe(6)
  })

  test('BSC still has no Circle USDC after the expansion (hard rule held)', () => {
    expect(() => resolveCuratedTokenAddress('bsc', 'USDC')).toThrow(CuratedLookupError)
  })

  test('BSC bridged USDC uses BINANCE_PEG_USDC (18 dec), never native USDC semantics', () => {
    // The bridged variant lives under a distinct preset name with 18 decimals
    // (Binance-Peg), NOT the 6 of Circle-native USDC. 'USDC' stays absent on BSC.
    expect(resolveCuratedTokenDecimals('bsc', 'BINANCE_PEG_USDC')).toBe(18)
    expect(() => resolveCuratedTokenAddress('bsc', 'USDC')).toThrow(CuratedLookupError)
  })

  test('USDT was NOT added to arbitrum/optimism/polygon (bridged, not issuer-native)', () => {
    for (const chain of ['arbitrum', 'optimism', 'polygon'] as const) {
      expect(() => resolveCuratedTokenAddress(chain, 'USDT')).toThrow(CuratedLookupError)
    }
  })
})
