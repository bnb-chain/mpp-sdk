import { connectorsForWallets } from '@rainbow-me/rainbowkit'
import { metaMaskWallet } from '@rainbow-me/rainbowkit/wallets'
import { http, createConfig } from 'wagmi'
import { bscTestnet } from 'wagmi/chains'

/**
 * Wagmi config — BSC Testnet only.
 *
 * BSC Testnet (chainId 97) is the only chain the demo settles on, so it's
 * the only one the wallet needs to switch / add. `hash` broadcasts a real
 * USDT transfer here and `permit2` signs against the same chain.
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
 * BSC Testnet RPC URL — defaults to the public data-seed endpoint (no API
 * key required at demo volume). Override per-deployment via
 * `VITE_BSC_TESTNET_RPC_URL` (e.g. a NodeReal / QuickNode URL with your own
 * key) when the public endpoint rate-limits the balance-refresh loop.
 */
const BSC_TESTNET_RPC_URL =
  import.meta.env.VITE_BSC_TESTNET_RPC_URL ?? 'https://data-seed-prebsc-1-s1.binance.org:8545'

export const wagmiConfig = createConfig({
  chains: [bscTestnet],
  connectors,
  transports: {
    [bscTestnet.id]: http(BSC_TESTNET_RPC_URL),
  },
  ssr: false,
})

export { bscTestnet }
