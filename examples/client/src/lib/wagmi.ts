import { connectorsForWallets } from '@rainbow-me/rainbowkit'
import { metaMaskWallet } from '@rainbow-me/rainbowkit/wallets'
import { http, createConfig } from 'wagmi'
import { bsc, bscTestnet } from 'wagmi/chains'

/**
 * Wagmi config — BSC Testnet (chainId 97) + BSC mainnet (chainId 56):
 *
 * - `hash` broadcasts a real TEST_USDT transfer; `permit2` signs against it
 *   (both testnet, against examples/server).
 * - `authorization` signs the EIP-3009 `transferWithAuthorization` for `$U`
 *   (the b402 web-wallet path — testnet OR mainnet preset). The demo never
 *   broadcasts the authorization itself — a b402-settling server
 *   (examples/server mode 3) does. ⚠️ The mainnet preset moves REAL $U.
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
