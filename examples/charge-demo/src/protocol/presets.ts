/**
 * Static metadata for the @bnb-chain/mpp interactive browser demo.
 *
 * Source-of-truth notes:
 *   - Token contract addresses + EIP-712 domains MIRROR the curated matrix
 *     in `src/server/curated.ts`. Any drift here is a demo bug, not a
 *     production-side bug — the SDK's curated matrix is what
 *     `preflightCharge` uses. We duplicate the values here because the
 *     browser demo doesn't run preflightCharge (no server-side path);
 *     we issue challenges client-side and need the same values bound
 *     into the wire request shape.
 *
 *   - Explorer / faucet URLs are per-chain conveniences for the UI
 *     ("View tx on Sepolia Etherscan", "Get test USDC from Circle
 *     faucet"). Not part of the SDK contract; just demo ergonomics.
 */

import { type Address } from 'viem'
import { base, bsc, mainnet, sepolia } from 'viem/chains'

/**
 * Chains the demo wallet integration knows about for switch / add prompts.
 * Used by `canSettleOnChain` to gate on-chain broadcast. Sepolia is the
 * only chain we settle on; the mainnet presets exist purely for the
 * WIRE-shape-only demo paths (no on-chain settlement — viem's chain
 * metadata is only used for EIP-712 domain formatting).
 */
const KNOWN_CHAIN_IDS: ReadonlySet<number> = new Set<number>([sepolia.id])

/* -------------------------------------------------------------------------- */
/*  Chain presets                                                              */
/* -------------------------------------------------------------------------- */

export interface ChainPreset {
  readonly chainId: number
  readonly key: string
  readonly label: string
  readonly currency: Address
  readonly decimals: number
  readonly token: string
  /** Set when the token contract supports EIP-3009 transferWithAuthorization. */
  readonly eip712?: { readonly name: string; readonly version: string }
  /** Whether the demo can actually broadcast on this chain via the connected
   *  wallet. Only testnet chains in `KNOWN_CHAINS` are settle-capable; the
   *  others are wire-shape demos (challenge + signature) without on-chain
   *  settlement. */
  readonly canSettle: boolean
  /** Block-explorer base URL for tx-hash / address links. */
  readonly explorerUrl?: string
  /** Faucet URL the demo links to when wallet balance is low. */
  readonly faucetUrl?: string
}

/**
 * Chain dropdown contents. Sepolia is the recommended (and only fully
 * end-to-end) option; mainnet entries stay for the wire-shape inspect
 * paths so the demo still showcases multi-chain token addresses + EIP-712
 * domain differences (mainnet USDC `name: "USD Coin"` vs sepolia USDC
 * `name: "USDC"`).
 */
export const CHAIN_PRESETS: readonly ChainPreset[] = [
  {
    key: 'sepolia',
    label: 'Sepolia (testnet, Circle USDC) — recommended',
    chainId: sepolia.id, // 11155111
    currency: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    decimals: 6,
    token: 'USDC',
    eip712: { name: 'USDC', version: '2' },
    canSettle: true,
    explorerUrl: 'https://sepolia.etherscan.io',
    // Circle's official faucet for testnet USDC. Requires a Web3 wallet
    // signed in via Coinbase / etc — point users at the URL and let them
    // grab their own.
    faucetUrl: 'https://faucet.circle.com',
  },
  {
    key: 'ethereum',
    label: 'Ethereum mainnet (wire-shape only)',
    chainId: mainnet.id,
    currency: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    decimals: 6,
    token: 'USDC',
    eip712: { name: 'USD Coin', version: '2' },
    canSettle: false,
    explorerUrl: 'https://etherscan.io',
  },
  {
    key: 'base',
    label: 'Base mainnet (wire-shape only)',
    chainId: base.id,
    currency: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    decimals: 6,
    token: 'USDC',
    eip712: { name: 'USD Coin', version: '2' },
    canSettle: false,
    explorerUrl: 'https://basescan.org',
  },
  {
    key: 'bsc',
    label: 'BSC mainnet (USDT, wire-shape only)',
    chainId: bsc.id,
    currency: '0x55d398326f99059ff775485246999027b3197955',
    decimals: 18,
    token: 'USDT',
    canSettle: false,
    explorerUrl: 'https://bscscan.com',
  },
]

export function getPresetByKey(key: string): ChainPreset {
  const found = CHAIN_PRESETS.find((p) => p.key === key)
  if (!found) throw new Error(`Unknown chain preset key: ${key}`)
  return found
}

export function getPresetByChainId(chainId: number): ChainPreset | null {
  return CHAIN_PRESETS.find((p) => p.chainId === chainId) ?? null
}

/* -------------------------------------------------------------------------- */
/*  Permit2                                                                    */
/* -------------------------------------------------------------------------- */

/** Canonical Permit2 — deployed at the same address on every supported chain
 *  including Sepolia (verified ~9KB bytecode). */
export const PERMIT2_ADDRESS: Address = '0x000000000022d473030f116ddee9f6b43ac78ba3'

/* -------------------------------------------------------------------------- */
/*  Credential-type metadata                                                   */
/* -------------------------------------------------------------------------- */

export type CredentialType = 'hash' | 'transaction' | 'permit2' | 'authorization'

export interface CredentialMeta {
  readonly title: string
  readonly icon: string
  readonly blurb: string
  /** Short description of what's REAL vs MOCKED in this demo path. */
  readonly realism: string
  /** Whether this credential type needs a real wallet to be meaningful. */
  readonly needsWallet: boolean
  /** Whether this credential type actually broadcasts on-chain in the demo. */
  readonly settlesOnChain: boolean
}

export const CREDENTIAL_META: Readonly<Record<CredentialType, CredentialMeta>> = {
  hash: {
    title: 'Hash',
    icon: '#',
    blurb: 'Reference an existing on-chain Transfer. No signing required.',
    realism:
      'REAL: wallet broadcasts a USDC transfer on Sepolia; the credential references the actual tx hash.',
    needsWallet: true,
    settlesOnChain: true,
  },
  transaction: {
    title: 'Transaction',
    icon: '⛽',
    blurb: 'Sign a full EIP-1559 transfer(...) RLP; server broadcasts.',
    realism:
      "PARTIAL: MetaMask can't expose a pre-signed-but-unbroadcast RLP. Demo uses an in-page random key to sign so you can see the wire shape — production deployments would have the client sign with their own keystore.",
    needsWallet: false,
    settlesOnChain: false,
  },
  permit2: {
    title: 'Permit2',
    icon: '🔏',
    blurb: 'EIP-712 single or batch (splits). Most powerful path.',
    realism:
      'REAL signature: MetaMask signs the EIP-712 typed data. Demo stops at credential (no broadcast) since Permit2 settlement is a server-side responsibility — the credential IS valid + would settle if presented to a real charge-server.',
    needsWallet: true,
    settlesOnChain: false,
  },
  authorization: {
    title: 'Authorization',
    icon: '🪪',
    blurb: 'EIP-3009 transferWithAuthorization. Circle USDC etc.',
    realism:
      'REAL signature: MetaMask signs the EIP-3009 typed data. Like Permit2, server-side settlement (transferWithAuthorization broadcast) is out of demo scope — the credential is valid + ready for a real charge-server.',
    needsWallet: true,
    settlesOnChain: false,
  },
}

/* -------------------------------------------------------------------------- */
/*  Explorer link helpers                                                      */
/* -------------------------------------------------------------------------- */

export function explorerTxUrl(chainId: number, txHash: string): string | null {
  const preset = getPresetByChainId(chainId)
  return preset?.explorerUrl ? `${preset.explorerUrl}/tx/${txHash}` : null
}

export function explorerAddressUrl(chainId: number, address: string): string | null {
  const preset = getPresetByChainId(chainId)
  return preset?.explorerUrl ? `${preset.explorerUrl}/address/${address}` : null
}

/* -------------------------------------------------------------------------- */
/*  Compatibility check — wallet chain vs selected preset                      */
/* -------------------------------------------------------------------------- */

/** True when the chain in the wallet matches the preset the user selected
 *  AND the chain is one the demo can actually broadcast on. */
export function canSettleOnChain(chainPresetKey: string, walletChainId: number | null): boolean {
  const preset = getPresetByKey(chainPresetKey)
  if (!preset.canSettle) return false
  if (walletChainId !== preset.chainId) return false
  return KNOWN_CHAIN_IDS.has(walletChainId)
}

/* -------------------------------------------------------------------------- */
/*  Persistence                                                                */
/* -------------------------------------------------------------------------- */

/**
 * localStorage keys used by the demo. Centralized here so they're discoverable
 * + namespaced (avoids collisions if the page is embedded elsewhere later).
 */
export const STORAGE_KEYS = {
  chainKey: 'mpp-demo:chain',
  credentialType: 'mpp-demo:credentialType',
  recipient: 'mpp-demo:recipient',
  realm: 'mpp-demo:realm',
  bindingMode: 'mpp-demo:bindingMode',
  amount: 'mpp-demo:amount',
  // End-to-end mode against a real charge-server (default: on, pointing
  // at the Vite dev-server proxy `/api/article` which forwards to
  // localhost:3000 — see vite.config.ts).
  serverMode: 'mpp-demo:serverMode',
  serverEndpoint: 'mpp-demo:serverEndpoint',
} as const

export function loadPersisted<T extends string>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return (v ?? fallback) as T
  } catch {
    return fallback
  }
}

export function savePersisted(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // localStorage may be unavailable (incognito + tight quota); ignore.
  }
}
