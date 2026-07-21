import { connectorsForWallets } from '@rainbow-me/rainbowkit'
import { metaMaskWallet } from '@rainbow-me/rainbowkit/wallets'
import { http, createConfig } from 'wagmi'
import { bsc, bscTestnet } from 'wagmi/chains'

/**
 * Wagmi config for the BSC networks advertised by the B402 demo server.
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
    appName: '@bnb-chain/mpp · B402 Demo',
    projectId: 'mpp-demo', // local-only demo; no WalletConnect projectId required
  },
)

/**
 * RPC URLs — default to the public endpoints (no API key required at demo
 * volume). Override per-deployment via `VITE_BSC_TESTNET_RPC_URL` /
 * `VITE_BSC_RPC_URL` (e.g. a NodeReal / QuickNode URL with your own key) when
 * the public endpoint rate-limits the balance-refresh loop.
 */
const BSC_TESTNET_RPC_URL =
  import.meta.env.VITE_BSC_TESTNET_RPC_URL ?? 'https://data-seed-prebsc-1-s1.binance.org:8545'
const BSC_RPC_URL = import.meta.env.VITE_BSC_RPC_URL ?? 'https://bsc-dataseed1.binance.org'

export const wagmiConfig = createConfig({
  chains: [bscTestnet, bsc],
  connectors,
  transports: {
    [bscTestnet.id]: http(BSC_TESTNET_RPC_URL),
    [bsc.id]: http(BSC_RPC_URL),
  },
  ssr: false,
})

export { bsc, bscTestnet }
