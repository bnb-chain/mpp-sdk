import { connectorsForWallets } from '@rainbow-me/rainbowkit'
import { metaMaskWallet } from '@rainbow-me/rainbowkit/wallets'
import { http, createConfig } from 'wagmi'
import { sepolia } from 'wagmi/chains'

/**
 * Wagmi config — Sepolia only.
 *
 * Sepolia is the only chain the demo can actually broadcast on, so it's
 * the only one the wallet needs to switch / add. The other `CHAIN_PRESETS`
 * entries are wire-shape inspect targets — we never broadcast against them,
 * so the wallet doesn't need to know about them.
 *
 * RainbowKit's `injected` connector covers MetaMask and other compatible
 * extensions automatically.
 */
const connectors = connectorsForWallets(
  [
    {
      groupName: 'Recommended',
      wallets: [metaMaskWallet],
    },
  ],
  {
    appName: '@bnb-chain/mpp · Interactive Demo',
    projectId: 'mpp-demo', // local-only demo; no WalletConnect projectId required
  },
)

/**
 * Sepolia RPC URL — defaults to publicnode (no rate limits at demo
 * volume, no API key required). viem's bare `http()` falls back to an
 * Ankr-flavoured public endpoint that 429s after a few requests, which
 * breaks the demo's auto-fetch + balance refresh loop. Override per-
 * deployment via `VITE_SEPOLIA_RPC_URL` (e.g. an Alchemy / Infura URL
 * with your own API key) when needed.
 */
const SEPOLIA_RPC_URL =
  import.meta.env.VITE_SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com'

export const wagmiConfig = createConfig({
  chains: [sepolia],
  connectors,
  transports: {
    [sepolia.id]: http(SEPOLIA_RPC_URL),
  },
  ssr: false,
})

export { sepolia }
