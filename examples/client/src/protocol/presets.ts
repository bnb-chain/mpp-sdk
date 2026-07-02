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
import { bsc, bscTestnet } from 'viem/chains'

/**
 * Chains the demo can BROADCAST on via the connected wallet (the `hash` path).
 * Used by `canSettleOnChain`. The testnet `$U` preset is EIP-3009
 * authorization-only (the buyer signs; a b402-settling server broadcasts), so
 * the demo never broadcasts it locally — both presets sit on chainId 97.
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
    faucetUrl: 'https://www.bnbchain.org/en/testnet-faucet',
  },
  {
    key: 'bsc-testnet-u',
    label: 'BSC Testnet ($U) — EIP-3009 / b402 (sign-only demo)',
    chainId: bscTestnet.id, // 97
    // United Stables ("$U") on BSC TESTNET — MIRRORS ('bsc-testnet', 'U') in
    // src/server/curated.ts. On-chain (2026-07-02): name="United Stables",
    // symbol="U", decimals=18, chainId=97; EIP-712 domain "United Stables"/"1"
    // VERIFIED via DOMAIN_SEPARATOR reconstruction (not assumed). The EIP-712
    // `name` is the on-chain name(), NOT the "U" ticker — docs/b402.md gotchas.
    // ⚠️ b402 authorization settles on THIS preset currently fail upstream:
    // the testnet facilitator's eip3009 kind advertises name "U", matching no
    // known testnet $U domain (ADR-0004 OQ2) — sign+submit demo only today.
    currency: '0xc70b8741b8b07a6d61e54fd4b20f22fa648e5565',
    decimals: 18,
    token: 'U',
    eip712: { name: 'United Stables', version: '1' },
    // The demo only SIGNS the EIP-3009 transferWithAuthorization; a b402-settling
    // server (examples/server mode 3) broadcasts + pays gas. So `canSettle`
    // is false — `hash`/`permit2` local-broadcast paths are not offered for this
    // preset (only `authorization` is — see `visibleCredentialTypes`).
    canSettle: false,
    explorerUrl: 'https://testnet.bscscan.com',
  },
  {
    key: 'bsc-u',
    label: 'BSC Mainnet ($U) — EIP-3009 / b402 ⚠️ REAL FUNDS',
    chainId: bsc.id, // 56
    // United Stables ("$U") on BSC MAINNET — MIRRORS ('bsc', 'U') in
    // src/server/curated.ts. EIP-712 domain "United Stables"/"1" is verified
    // on-chain there (DOMAIN_SEPARATOR-locked in curated.test.ts). Pair with
    // examples/server mode 3 running B402_CHAIN=bsc — every settle moves REAL $U.
    currency: '0xcE24439F2D9C6a2289F741120FE202248B666666',
    decimals: 18,
    token: 'U',
    eip712: { name: 'United Stables', version: '1' },
    // Sign-only, like the testnet $U preset: b402 broadcasts + pays gas.
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
 *  including BSC Testnet (verified ~9KB bytecode at chainId 97). */
export const PERMIT2_ADDRESS: Address = '0x000000000022d473030f116ddee9f6b43ac78ba3'

/* -------------------------------------------------------------------------- */
/*  Credential-type metadata                                                   */
/* -------------------------------------------------------------------------- */

export type CredentialType = 'hash' | 'permit2' | 'authorization' | 'x402'

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
  permit2: {
    title: 'Permit2',
    icon: '🔏',
    blurb: 'EIP-712 single or batch (splits). Most powerful path.',
    realism:
      'REAL signature: MetaMask signs the EIP-712 typed data. Demo stops at credential (no broadcast) since Permit2 settlement is a server-side responsibility — the credential IS valid + would settle if presented to a permit2-capable server (examples/server mode 2).',
    needsWallet: true,
    settlesOnChain: false,
  },
  authorization: {
    title: 'Authorization',
    icon: '🪪',
    blurb: 'EIP-3009 transferWithAuthorization ($U via b402).',
    realism:
      "REAL signature: MetaMask signs the EIP-3009 typed data for $U on the selected preset's chain (no gas, no broadcast here). Submit forwards the credential to a mode-3 server, which settles through b402. ⚠️ Settlement works on the MAINNET preset only today (REAL funds — the wallet must hold mainnet $U); on the testnet preset the facilitator's kind mismatches the token domain (ADR-0004 OQ2), so it stops at signing + submit, as it does against a server without mode 3.",
    needsWallet: true,
    settlesOnChain: false,
  },
  x402: {
    title: 'x402 · Permit2',
    icon: '🌉',
    blurb:
      'Standalone x402 wire (JSON 402 + X-PAYMENT) — b402 permit2-exact, the road for tokens without a usable EIP-3009 door.',
    realism:
      'REAL end-to-end when the server enables its /x402 route (examples/server mode 3 + X402_TOKEN_ADDRESS): step 2 sends a one-time on-chain approve(Permit2, max) if allowance is short (costs gas ⚠️), then MetaMask signs the PermitWitnessTransferFrom typed data; step 4 pays with the X-PAYMENT header and b402 broadcasts the transfer (⚠️ REAL funds on mainnet). The SDK refuses to sign for any spender outside the curated b402 allowlist.',
    needsWallet: true,
    settlesOnChain: false,
  },
}

/**
 * Credential methods surfaced in the demo's tab bar, PER selected chain preset.
 * The tabs follow what the token actually supports:
 *
 *   - EIP-3009 tokens (`bsc`/U) → `authorization`. The buyer wallet signs
 *     `transferWithAuthorization`; a b402-settling server (examples/server
 *     mode 3) broadcasts. This IS the b402 web-wallet path.
 *   - plain BEP-20s (`bsc-testnet`/USDT) → `hash` (real on-chain settlement) +
 *     `permit2` (real wallet-signed EIP-712).
 *   - `x402` (b402 permit2-exact on the standalone x402 wire) is chain-driven,
 *     not token-driven: the 402 JSON body tells us the asset, so the tab shows
 *     on EVERY preset — the preset only picks which network's offer we accept.
 *     Step 1 reports clearly when the server has no /x402 route.
 *
 * The mppx wire also defines a `transaction` credential (pre-signed EIP-1559
 * RLP) — not demoed here because MetaMask can't expose a
 * pre-signed-unbroadcast transaction; a Node buyer with its own keystore can
 * build it via `createTransactionCredential`.
 */
export function visibleCredentialTypes(
  preset: ChainPreset,
): readonly [CredentialType, ...CredentialType[]] {
  return preset.eip712 ? ['authorization', 'x402'] : ['hash', 'permit2', 'x402']
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
// NOTE: the demo always runs end-to-end against a live server; the endpoint
// follows the .env default (VITE_DEFAULT_ENDPOINT, /api/premium when unset)
// and is deliberately NOT persisted, so retargeting via .env takes effect
// without clearing site data.
export const STORAGE_KEYS = {
  chainKey: 'mpp-demo:chain',
  credentialType: 'mpp-demo:credentialType',
  recipient: 'mpp-demo:recipient',
  realm: 'mpp-demo:realm',
  amount: 'mpp-demo:amount',
} as const

export function savePersisted(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // localStorage may be unavailable (incognito + tight quota); ignore.
  }
}
