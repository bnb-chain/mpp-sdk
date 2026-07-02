/**
 * Curated chain + token presets for EVM Charge (spec §5.2 / §5.3).
 *
 * SDK-internal utility — not part of the public package exports. Called from
 * `preflightCharge` (§10) to:
 *   - resolve a `SupportedChainPreset` to viem Chain metadata + chainId + RPC,
 *   - resolve a `(SupportedChainPreset, SupportedTokenPreset)` pair to the
 *     ERC-20 contract address, decimals, and EIP-3009 support flag,
 *   - derive the per-pair credential-type allowlist.
 *
 * Adding a new (chain, token) entry requires:
 *   1. explorer-verified contract address (link in README "Tokens"),
 *   2. on-chain `decimals()` call to confirm the decimals value,
 *   3. on-chain probe to confirm EIP-3009 support iff `eip3009Supported: true`
 *      (any `(chain, token)` with `eip3009Supported: true` and no matching
 *      `transferWithAuthorization` selector is a security bug).
 *
 * Preset name semantics (hard rule, spec §5.3):
 *   - 'USDC' / 'USDT' / 'EURC' / 'FDUSD' / 'PYUSD' / 'USDP' / 'USDG' / 'U' mean
 *     ONLY the native issuer's contract on that chain (e.g. 'USDT' = Tether
 *     native, as on Ethereum).
 *   - Bridged / Binance-Peg / wrapped variants use a distinct 'BINANCE_PEG_*'
 *     preset name (e.g. 'BINANCE_PEG_USDC', 'BINANCE_PEG_DAI') so they never
 *     wear native-issuer semantics — see §20.2 Future Work.
 *   - 'TEST_USDT' is testnet-only: never appears in a mainnet matrix entry,
 *     never aliased to Tether's official mainnet USDT.
 */

import {
  arbitrum,
  arbitrumSepolia,
  avalanche,
  avalancheFuji,
  base,
  baseSepolia,
  bsc,
  bscTestnet,
  type Chain,
  linea,
  lineaSepolia,
  mainnet,
  opBNB,
  opBNBTestnet,
  optimism,
  optimismSepolia,
  polygon,
  polygonAmoy,
  sepolia,
} from 'viem/chains'

import type { CredentialType } from '../Methods.js'

/* -------------------------------------------------------------------------- */
/*  Chain presets                                                             */
/* -------------------------------------------------------------------------- */

export type SupportedChainPreset =
  // Mainnet
  | 'ethereum'
  | 'base'
  | 'arbitrum'
  | 'optimism'
  | 'polygon'
  | 'avalanche'
  | 'linea'
  | 'bsc'
  | 'opbnb'
  // Testnet
  | 'sepolia'
  | 'base-sepolia'
  | 'arbitrum-sepolia'
  | 'optimism-sepolia'
  | 'polygon-amoy'
  | 'avalanche-fuji'
  | 'linea-sepolia'
  | 'bsc-testnet'
  | 'opbnb-testnet'

interface ChainMetadata {
  readonly chainId: number
  readonly viemChain: Chain
  readonly defaultRpcUrl: string | undefined
  /**
   * Conservative confirmations starting point (spec §5.2.1). Tunable per
   * deployment via ServerParameters; this is the SDK default when callers
   * don't override.
   */
  readonly defaultConfirmations: number
}

/**
 * Source of truth for chain-level metadata. RPC URLs use viem's bundled
 * defaults (public providers); deployments under real traffic SHOULD override
 * via `ServerParameters.rpcUrl`.
 */
const CHAIN_METADATA: Readonly<Record<SupportedChainPreset, ChainMetadata>> = {
  // Mainnet
  ethereum: { chainId: 1, viemChain: mainnet, defaultRpcUrl: undefined, defaultConfirmations: 12 },
  base: { chainId: 8453, viemChain: base, defaultRpcUrl: undefined, defaultConfirmations: 1 },
  arbitrum: {
    chainId: 42161,
    viemChain: arbitrum,
    defaultRpcUrl: undefined,
    defaultConfirmations: 1,
  },
  optimism: { chainId: 10, viemChain: optimism, defaultRpcUrl: undefined, defaultConfirmations: 1 },
  polygon: {
    chainId: 137,
    viemChain: polygon,
    defaultRpcUrl: undefined,
    defaultConfirmations: 5,
  },
  avalanche: {
    chainId: 43114,
    viemChain: avalanche,
    defaultRpcUrl: undefined,
    defaultConfirmations: 1,
  },
  linea: { chainId: 59144, viemChain: linea, defaultRpcUrl: undefined, defaultConfirmations: 1 },
  bsc: { chainId: 56, viemChain: bsc, defaultRpcUrl: undefined, defaultConfirmations: 3 },
  opbnb: { chainId: 204, viemChain: opBNB, defaultRpcUrl: undefined, defaultConfirmations: 1 },
  // Testnet (defaultConfirmations: 0 for dev velocity)
  sepolia: {
    chainId: 11155111,
    viemChain: sepolia,
    defaultRpcUrl: undefined,
    defaultConfirmations: 0,
  },
  'base-sepolia': {
    chainId: 84532,
    viemChain: baseSepolia,
    defaultRpcUrl: undefined,
    defaultConfirmations: 0,
  },
  'arbitrum-sepolia': {
    chainId: 421614,
    viemChain: arbitrumSepolia,
    defaultRpcUrl: undefined,
    defaultConfirmations: 0,
  },
  'optimism-sepolia': {
    chainId: 11155420,
    viemChain: optimismSepolia,
    defaultRpcUrl: undefined,
    defaultConfirmations: 0,
  },
  'polygon-amoy': {
    chainId: 80002,
    viemChain: polygonAmoy,
    defaultRpcUrl: undefined,
    defaultConfirmations: 0,
  },
  'avalanche-fuji': {
    chainId: 43113,
    viemChain: avalancheFuji,
    defaultRpcUrl: undefined,
    defaultConfirmations: 0,
  },
  'linea-sepolia': {
    chainId: 59141,
    viemChain: lineaSepolia,
    defaultRpcUrl: undefined,
    defaultConfirmations: 0,
  },
  'bsc-testnet': {
    chainId: 97,
    viemChain: bscTestnet,
    defaultRpcUrl: undefined,
    defaultConfirmations: 0,
  },
  'opbnb-testnet': {
    chainId: 5611,
    viemChain: opBNBTestnet,
    defaultRpcUrl: undefined,
    defaultConfirmations: 0,
  },
}

/* -------------------------------------------------------------------------- */
/*  Token presets                                                             */
/* -------------------------------------------------------------------------- */

export type SupportedTokenPreset =
  | 'USDC'
  | 'USDT'
  | 'EURC'
  | 'FDUSD'
  | 'PYUSD'
  | 'USDP'
  | 'USDG'
  | 'U'
  | 'BINANCE_PEG_USDC'
  | 'BINANCE_PEG_USDT'
  | 'BINANCE_PEG_DAI'
  | 'TEST_USDT'

type Hex = `0x${string}`

interface TokenEntry {
  readonly address: Hex
  readonly decimals: number
  readonly eip3009Supported: boolean
  /**
   * EIP-712 domain `name` for EIP-3009 (e.g. "USD Coin" for Circle USDC).
   * REQUIRED iff `eip3009Supported: true`; ignored otherwise.
   */
  readonly eip712Name?: string
  /**
   * EIP-712 domain `version` for EIP-3009 (e.g. "2" for Circle USDC).
   * REQUIRED iff `eip3009Supported: true`; ignored otherwise.
   */
  readonly eip712Version?: string
}

/**
 * Per-(chain, token) entries. Sparse Map: only present pairs are supported.
 *
 * Implementer note: every entry below MUST have its address verified via the
 * chain's explorer ("verified contract" badge) AND a manual `decimals()` call.
 *
 * `eip3009Supported` policy: set `true` ONLY after an on-chain
 * `transferWithAuthorization` + `DOMAIN_SEPARATOR()` probe confirms support AND
 * the exact EIP-712 `name`/`version` — the domain string is part of the signed
 * payload, so inferring it from the token symbol ("it's called USDC") is a
 * verification bug. Entries added without that probe ship
 * `eip3009Supported: false`: they advertise `permit2` / `transaction` / `hash`
 * only, and flipping a token to `authorization` is a probe-gated follow-up.
 * Addresses + decimals come from the issuer's official contract-address pages
 * (Circle / PayPal / Paxos / Tether / First Digital), linked in README "Tokens".
 */
const TOKEN_MATRIX: Readonly<
  Partial<Record<SupportedChainPreset, Partial<Record<SupportedTokenPreset, TokenEntry>>>>
> = {
  // ── Ethereum mainnet ──
  ethereum: {
    USDC: {
      // Circle native USDC, verified on Etherscan.
      address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      decimals: 6,
      eip3009Supported: true,
      eip712Name: 'USD Coin',
      eip712Version: '2',
    },
    USDT: {
      // Tether USD, verified on Etherscan.
      address: '0xdac17f958d2ee523a2206206994597c13d831ec7',
      decimals: 6,
      eip3009Supported: false,
    },
    EURC: {
      // Circle EURC. Source: Circle EURC contract addresses. Circle's
      // FiatToken implements EIP-3009 — eip3009Supported stays false until a
      // per-chain DOMAIN_SEPARATOR() + transferWithAuthorization probe locks
      // the exact EIP-712 domain.
      address: '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c',
      decimals: 6,
      eip3009Supported: false,
    },
    PYUSD: {
      // PayPal USD (issued by Paxos). Source: PayPal / Paxos PYUSD docs.
      address: '0x6c3ea9036406852006290770BEdFcAbA0e23A0e8',
      decimals: 18,
      eip3009Supported: false,
    },
    USDP: {
      // Pax Dollar (Paxos). Source: Paxos USDP docs.
      address: '0x8E870D67F660D95d5be530380D0eC0bd388289E1',
      decimals: 18,
      eip3009Supported: false,
    },
    USDG: {
      // Global Dollar (Paxos). Source: Paxos USDG docs.
      address: '0xe343167631d89B6Ffc58B88d6b7fB0228795491D',
      decimals: 6,
      eip3009Supported: false,
    },
    FDUSD: {
      // First Digital USD on Ethereum. Source: First Digital Labs. NOTE: the
      // issuer lists the same address on Ethereum and BSC; the BSC entry below
      // has a probed EIP-3009 domain, but this Ethereum deployment stays
      // eip3009Supported: false until separately probed on chainId 1.
      address: '0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409',
      decimals: 18,
      eip3009Supported: false,
    },
  },
  // ── BSC mainnet ──
  bsc: {
    BINANCE_PEG_USDT: {
      // Binance-Peg Tether (BSC-USD) on BSC — bridged, NOT Tether-native, so it
      // uses the BINANCE_PEG_* name (migrated from the legacy 'USDT' alias).
      // Verified on BscScan. 18 decimals (Binance-Peg), NOT 6. Standard BEP-20,
      // no EIP-3009.
      // ⚠️ BSC has no Circle native USDC. Do not add ('bsc', 'USDC') — the
      // bridged variant is 'BINANCE_PEG_USDC' below.
      address: '0x55d398326f99059ff775485246999027b3197955',
      decimals: 18,
      eip3009Supported: false,
    },
    FDUSD: {
      // First Digital USD (First Digital Labs), verified on BscScan:
      // https://bscscan.com/token/0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409
      // On-chain probes (2026-05-28): name="First Digital USD", symbol="FDUSD",
      // decimals=18. DOMAIN_SEPARATOR() returns
      //   0xac2ff863e00ee93e90d01514d46b9b8179ca650e856138a6d8aea00702ca62a0
      // which matches keccak(EIP712Domain(...)) with name="First Digital USD",
      // version="1", chainId=56, verifyingContract=this. transferWithAuthorization
      // selector is `0xe3ee160e` (keccak of the canonical EIP-3009
      // signature transferWithAuthorization(address,address,uint256,uint256,
      // uint256,bytes32,uint8,bytes32,bytes32) truncated to 4 bytes) — a
      // probe `eth_call` lands on the function and reverts with
      // "Invalid signature" on a placeholder payload, confirming EIP-3009
      // SUPPORTED.
      address: '0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409',
      decimals: 18,
      eip3009Supported: true,
      eip712Name: 'First Digital USD',
      eip712Version: '1',
    },
    U: {
      // United Stables ("$U"), verified on BscScan:
      // https://bscscan.com/token/0xcE24439F2D9C6a2289F741120FE202248B666666
      // On-chain probes (2026-05-28): name="United Stables", symbol="U",
      // decimals=18. DOMAIN_SEPARATOR() returns
      //   0x358738403e5a61fdc30a8be78a60f289cbe4d2545b735a344b6229c70c1679b6
      // which matches keccak(EIP712Domain(...)) with name="United Stables",
      // version="1", chainId=56, verifyingContract=this. transferWithAuthorization
      // selector `0xe3ee160e` (same canonical EIP-3009 signature as FDUSD
      // above) is present — probe `eth_call` reverts with "Invalid
      // signature" on a placeholder payload, confirming EIP-3009 SUPPORTED
      // on mainnet.
      //
      // ⚠️ The BSC testnet sibling at 0x2Ae938053c112Bd81042043945d142e208b50a66
      // does NOT implement EIP-3009 — probing transferWithAuthorization
      // (selector 0xe3ee160e) falls through to "Contract does not have
      // fallback nor receive functions". The b402 TESTNET deployment is a
      // DIFFERENT contract (0xc70b8741b8b07a6d61e54fd4b20f22fa648e5565) that DOES
      // implement it — see ('bsc-testnet', 'U') below.
      address: '0xcE24439F2D9C6a2289F741120FE202248B666666',
      decimals: 18,
      eip3009Supported: true,
      eip712Name: 'United Stables',
      eip712Version: '1',
    },
    BINANCE_PEG_USDC: {
      // Binance-Peg USD Coin on BSC — bridged, NOT Circle native USDC (hence
      // the distinct preset name). Verified on BscScan. 18 decimals
      // (Binance-Peg), NOT 6. Standard BEP-20, no EIP-3009.
      address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
      decimals: 18,
      eip3009Supported: false,
    },
    BINANCE_PEG_DAI: {
      // Binance-Peg Dai Token on BSC — bridged. Verified on BscScan. 18
      // decimals. Standard BEP-20, no EIP-3009.
      address: '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3',
      decimals: 18,
      eip3009Supported: false,
    },
  },
  // ── Base mainnet ──
  base: {
    USDC: {
      // Circle native USDC on Base, verified on BaseScan.
      address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      decimals: 6,
      eip3009Supported: true,
      eip712Name: 'USD Coin',
      eip712Version: '2',
    },
    EURC: {
      // Circle EURC on Base. Source: Circle EURC contract addresses.
      address: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42',
      decimals: 6,
      eip3009Supported: false,
    },
  },
  // ── Arbitrum One ──
  arbitrum: {
    USDC: {
      // Circle native USDC on Arbitrum. Source: Circle USDC contract addresses.
      address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      decimals: 6,
      eip3009Supported: false,
    },
    FDUSD: {
      // First Digital USD on Arbitrum. Source: First Digital Labs.
      address: '0x93C9932E4afa59201F0B5E63f7d816516F1669fE',
      decimals: 18,
      eip3009Supported: false,
    },
    PYUSD: {
      // PayPal USD on Arbitrum (Paxos). Source: PayPal / Paxos PYUSD docs.
      address: '0x46850aD61C2B7d64d08c9C754F45254596696984',
      decimals: 18,
      eip3009Supported: false,
    },
  },
  // ── Optimism ──
  optimism: {
    USDC: {
      // Circle native USDC on Optimism. Source: Circle USDC contract addresses.
      address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
      decimals: 6,
      eip3009Supported: false,
    },
  },
  // ── Polygon PoS ──
  polygon: {
    USDC: {
      // Circle native USDC on Polygon. Source: Circle USDC contract addresses.
      address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
      decimals: 6,
      eip3009Supported: false,
    },
  },
  // ── Avalanche C-Chain ──
  avalanche: {
    USDC: {
      // Circle native USDC on Avalanche. Source: Circle USDC contract addresses.
      address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
      decimals: 6,
      eip3009Supported: false,
    },
    EURC: {
      // Circle EURC on Avalanche. Source: Circle EURC contract addresses.
      address: '0xC891EB4cbdEFf6e073e859e987815Ed1505c2ACD',
      decimals: 6,
      eip3009Supported: false,
    },
    USDT: {
      // Tether USD₮ on Avalanche. Source: Tether supported protocols.
      address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7',
      decimals: 6,
      eip3009Supported: false,
    },
  },
  // ── Linea ──
  linea: {
    USDC: {
      // Circle native USDC on Linea. Source: Circle USDC contract addresses.
      address: '0x176211869cA2b568f2A7D4EE941E073a821EE1ff',
      decimals: 6,
      eip3009Supported: false,
    },
  },
  // ── Ethereum Sepolia (testnet, Circle native USDC) ──
  //
  // Added for the interactive browser demo (`examples/client`) so the
  // demo can exercise real on-chain settlement on testnet without burning
  // mainnet gas. Circle ships USDC natively on Sepolia (faucet:
  // https://faucet.circle.com); same `name`/`version` EIP-712 domain as
  // mainnet USDC, so EIP-3009 + Permit2 paths work end-to-end.
  sepolia: {
    USDC: {
      // Circle native USDC on Sepolia. Verified on Sepolia Etherscan:
      // https://sepolia.etherscan.io/token/0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238
      // Source: https://developers.circle.com/stablecoins/usdc-on-test-networks
      address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      decimals: 6,
      eip3009Supported: true,
      eip712Name: 'USDC',
      eip712Version: '2',
    },
    EURC: {
      // Circle EURC on Sepolia. Source: Circle EURC contract addresses.
      address: '0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4',
      decimals: 6,
      eip3009Supported: false,
    },
    PYUSD: {
      // PayPal USD on Sepolia (Paxos). Source: Paxos PYUSD testnet docs.
      address: '0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9',
      decimals: 18,
      eip3009Supported: false,
    },
  },
  // ── Base Sepolia ──
  'base-sepolia': {
    USDC: {
      // Circle native USDC on Base Sepolia. Source: Circle USDC test networks.
      address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      decimals: 6,
      eip3009Supported: false,
    },
    EURC: {
      // Circle EURC on Base Sepolia. Source: Circle EURC contract addresses.
      address: '0x808456652fdb597867f38412077A9182bf77359F',
      decimals: 6,
      eip3009Supported: false,
    },
  },
  // ── Arbitrum Sepolia ──
  'arbitrum-sepolia': {
    USDC: {
      // Circle native USDC on Arbitrum Sepolia. Source: Circle USDC test networks.
      address: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
      decimals: 6,
      eip3009Supported: false,
    },
    PYUSD: {
      // PayPal USD on Arbitrum Sepolia (Paxos). Source: Paxos PYUSD testnet docs.
      address: '0x637A1259C6afd7E3AdF63993cA7E58BB438aB1B1',
      decimals: 18,
      eip3009Supported: false,
    },
  },
  // ── Optimism Sepolia ──
  'optimism-sepolia': {
    USDC: {
      // Circle native USDC on Optimism Sepolia. Source: Circle USDC test networks.
      address: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7',
      decimals: 6,
      eip3009Supported: false,
    },
  },
  // ── Polygon Amoy ──
  'polygon-amoy': {
    USDC: {
      // Circle native USDC on Polygon Amoy. Source: Circle USDC test networks.
      address: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
      decimals: 6,
      eip3009Supported: false,
    },
  },
  // ── Avalanche Fuji ──
  'avalanche-fuji': {
    USDC: {
      // Circle native USDC on Avalanche Fuji. Source: Circle USDC test networks.
      address: '0x5425890298aed601595a70AB815c96711a31Bc65',
      decimals: 6,
      eip3009Supported: false,
    },
    EURC: {
      // Circle EURC on Avalanche Fuji. Source: Circle EURC contract addresses.
      address: '0x5E44db7996c682E92a960b65AC713a54AD815c6B',
      decimals: 6,
      eip3009Supported: false,
    },
  },
  // ── Linea Sepolia ──
  'linea-sepolia': {
    USDC: {
      // Circle native USDC on Linea Sepolia. Source: Circle USDC test networks.
      address: '0xFEce4462D57bD51A6A552365A011b95f0E16d9B7',
      decimals: 6,
      eip3009Supported: false,
    },
  },
  // ── BSC Testnet (TEST_USDT — PancakeSwap test USDT, pinned) ──
  'bsc-testnet': {
    TEST_USDT: {
      // PancakeSwap test USDT, verified on BscScan testnet:
      // https://testnet.bscscan.com/token/0x337610d27c682E347C9cD60BD4b3b107C9d34dDd
      // On-chain probe (2026-06-08 via data-seed-prebsc-1-s1.binance.org):
      // symbol="USDT", name="USDT Token", decimals=18, chainId=97. Standard
      // BEP-20 — no EIP-3009, so it advertises permit2 / transaction / hash
      // only. Pinned for the interactive example client/server pair
      // end-to-end testnet settlement (Permit2 deployed at the canonical
      // address on chain 97, verified ~9KB bytecode).
      address: '0x337610d27c682E347C9cD60BD4b3b107C9d34dDd',
      decimals: 18,
      eip3009Supported: false,
    },
    U: {
      // United Stables ("$U") on BSC TESTNET. Three same-name deployments exist;
      // this pins 0xC70b…5565 — the one holding circulating test funds, with
      // ALL reads public. On-chain probe (2026-07-02):
      //   name()="United Stables", symbol()="U", decimals()=18, chainId=97;
      //   EIP-712 domain VERIFIED by DOMAIN_SEPARATOR() reconstruction —
      //   name "United Stables", version "1" (cryptographic match, not assumed);
      //   authorizationState() / transfer / approve publicly callable (no
      //   facilitator gate observed on any probed read).
      // Siblings deliberately NOT curated: 0x2Ae9…0a66 (no EIP-3009 at all) and
      // 0x180B…6A49 (facilitator-gated: DOMAIN_SEPARATOR/version/authorizationState
      // all revert, domain unreadable on-chain).
      // ⚠️ b402 CAVEAT: the testnet facilitator's /supported eip3009 kind
      //   advertises extra.name "U", which does NOT match this contract's
      //   EIP-712 name ("United Stables") — so B402Adapter.#resolveKind finds no
      //   matching testnet kind and the b402 settle path fails safe (mainnet is
      //   the verified-working b402 eip3009 chain). Tracked as ADR-0004 open
      //   question 2; the local-signer settle path is unaffected.
      address: '0xc70b8741b8b07a6d61e54fd4b20f22fa648e5565',
      decimals: 18,
      eip3009Supported: true,
      eip712Name: 'United Stables',
      eip712Version: '1',
    },
  },
  // ── opBNB Testnet (TEST_USDT — NOT yet pinned) ──
  'opbnb-testnet': {
    TEST_USDT: {
      // ⚠️ TODO: pin an opBNB-testnet-verified contract address here before
      // the opBNB live-test PR lands. This sentinel zero address forces an
      // explicit human review before any live test broadcasts, and keeps the
      // preflight sentinel-zero-address rejection guard exercised
      // (see src/server/Charge.test.ts).
      address: '0x0000000000000000000000000000000000000000',
      decimals: 18,
      eip3009Supported: false,
    },
  },
}

/* -------------------------------------------------------------------------- */
/*  Resolver helpers                                                          */
/* -------------------------------------------------------------------------- */

export class CuratedLookupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CuratedLookupError'
  }
}

export function resolveCuratedChainId(chain: SupportedChainPreset): number {
  return CHAIN_METADATA[chain].chainId
}

export function curatedViemChain(chain: SupportedChainPreset): Chain {
  return CHAIN_METADATA[chain].viemChain
}

export function curatedRpcUrl(chain: SupportedChainPreset): string | undefined {
  return CHAIN_METADATA[chain].defaultRpcUrl
}

export function curatedDefaultConfirmations(chain: SupportedChainPreset): number {
  return CHAIN_METADATA[chain].defaultConfirmations
}

function lookupTokenEntry(chain: SupportedChainPreset, token: SupportedTokenPreset): TokenEntry {
  const entry = TOKEN_MATRIX[chain]?.[token]
  if (!entry) {
    throw new CuratedLookupError(
      `(chain="${chain}", token="${token}") is not in the v1 curated matrix. ` +
        `See src/server/curated.ts TOKEN_MATRIX — add only after explorer-verified address ` +
        `+ on-chain decimals() confirmation.`,
    )
  }
  return entry
}

export function resolveCuratedTokenAddress(
  chain: SupportedChainPreset,
  token: SupportedTokenPreset,
): Hex {
  return lookupTokenEntry(chain, token).address
}

export function resolveCuratedTokenDecimals(
  chain: SupportedChainPreset,
  token: SupportedTokenPreset,
): number {
  return lookupTokenEntry(chain, token).decimals
}

export function isCuratedEip3009Supported(
  chain: SupportedChainPreset,
  token: SupportedTokenPreset,
): boolean {
  return lookupTokenEntry(chain, token).eip3009Supported
}

export function getCuratedEip712Domain(
  chain: SupportedChainPreset,
  token: SupportedTokenPreset,
): { name: string; version: string } {
  const entry = lookupTokenEntry(chain, token)
  if (!entry.eip3009Supported || !entry.eip712Name || !entry.eip712Version) {
    throw new CuratedLookupError(
      `(chain="${chain}", token="${token}") does not support EIP-3009 — no EIP-712 domain.`,
    )
  }
  return { name: entry.eip712Name, version: entry.eip712Version }
}

/**
 * Per-(chain, token) credential-type allowlist (spec §5.3).
 *
 * Base set: always includes 'transaction' and 'hash' (draft §4.2.2 MUST/SHOULD).
 * Conditional inclusions:
 *   - 'permit2': included as a candidate; preflight (§10) further probes the
 *     Permit2 contract deployment and may remove it if not deployed.
 *   - 'authorization': included iff curated entry has `eip3009Supported: true`.
 *     No runtime probing — the matrix is authoritative (spec §5.3
 *     Authorization-enablement rule).
 *
 * Returned ORDER is the deployment's preference list (draft Table 2).
 * Clients SHOULD pick the first type they support and the server's
 * request hook (`src/server/Charge.ts`) rejects any route override that
 * reorders or substitutes the array — both the set AND the sequence
 * must match the preflight-resolved value. Do NOT shuffle or sort
 * downstream; the order is semantic.
 *
 * Concrete order by (chain, token):
 *   - EIP-3009 token (e.g. ethereum/USDC, base/USDC):
 *       ['authorization', 'permit2', 'transaction', 'hash']
 *       authorization first — most gas-efficient for the payer, single
 *       on-chain settlement signed once.
 *   - non-EIP-3009 token (e.g. bsc/USDT, ethereum/USDT):
 *       ['permit2', 'transaction', 'hash']
 *       permit2 first when available (still 1-tx for the payer).
 */
export function getAcceptedCredentialTypes(
  chain: SupportedChainPreset,
  token: SupportedTokenPreset,
): readonly CredentialType[] {
  const entry = lookupTokenEntry(chain, token)
  const types: CredentialType[] = ['permit2', 'transaction', 'hash']
  if (entry.eip3009Supported) types.unshift('authorization')
  return types
}
