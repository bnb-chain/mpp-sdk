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
 *     ("View tx on BscScan testnet", "Get tBNB from the BNB Chain
 *     faucet"). Not part of the SDK contract; just demo ergonomics.
 */

import { type Address } from 'viem'
import { bscTestnet } from 'viem/chains'

/**
 * Chains the demo wallet integration knows about for switch / add prompts.
 * Used by `canSettleOnChain` to gate on-chain broadcast. The demo is
 * single-chain: BSC Testnet (chainId 97) is the only chain we settle on.
 */
const KNOWN_CHAIN_IDS: ReadonlySet<number> = new Set<number>([bscTestnet.id])

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
 * Chain dropdown contents. Single-chain demo: BSC Testnet (chainId 97)
 * with PancakeSwap test USDT. It's the only settle-capable preset, so
 * `hash` broadcasts a real on-chain transfer and `permit2` signs against
 * its currency address.
 */
export const CHAIN_PRESETS: readonly ChainPreset[] = [
  {
    key: 'bsc-testnet',
    label: 'BSC Testnet (USDT) — recommended',
    chainId: bscTestnet.id, // 97
    // PancakeSwap test USDT, verified on BscScan:
    // https://testnet.bscscan.com/token/0x337610d27c682E347C9cD60BD4b3b107C9d34dDd
    // On-chain probe (2026-06-08 via data-seed-prebsc-1-s1): symbol="USDT",
    // name="USDT Token", decimals=18, chainId=97. Standard BEP-20 — no
    // EIP-3009 — so the demo exposes `hash` + `permit2` only (no
    // `authorization` path; `eip712` intentionally omitted).
    currency: '0x337610d27c682E347C9cD60BD4b3b107C9d34dDd',
    decimals: 18,
    token: 'USDT',
    canSettle: true,
    explorerUrl: 'https://testnet.bscscan.com',
    // BNB Chain testnet faucet — dispenses tBNB for gas (required to
    // broadcast the hash-path USDT transfer).
    faucetUrl: 'https://testnet.bnbchain.org/faucet-smart',
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
 *  including BSC Testnet (verified ~9KB bytecode at chainId 97). */
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
      'REAL: wallet broadcasts a USDT transfer on BSC Testnet; the credential references the actual tx hash.',
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

/**
 * Credential methods surfaced in the demo's tab bar. The demo intentionally
 * showcases only `hash` (real on-chain settlement) and `permit2` (real
 * wallet-signed EIP-712) on BSC Testnet USDT. `transaction` and
 * `authorization` stay in the `CredentialType` union + action code (so the
 * step pipeline keeps a complete switch), but are hidden from the UI —
 * BSC Testnet USDT is a plain BEP-20 with no EIP-3009, so `authorization`
 * wouldn't apply, and `transaction` is the in-page-key wire-shape path we're
 * not demoing here.
 */
export const VISIBLE_CREDENTIAL_TYPES: readonly CredentialType[] = ['hash', 'permit2']

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
  // End-to-end (charge-server) mode is hidden in this build — the demo runs
  // local-only. These keys are retained so the server-mode code paths still
  // compile; `serverMode` is forced false in App.tsx (the toggle is gone).
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
