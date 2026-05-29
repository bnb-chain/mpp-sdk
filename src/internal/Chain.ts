/**
 * viem Chain type + curated chain re-exports.
 *
 * Centralises which viem chains this SDK depends on so callers can import
 * from `@bnb-chain/mpp/server` without reaching into `viem/chains`
 * directly. The chain list mirrors `SupportedChainPreset` in
 * `src/server/curated.ts`.
 */

export type { Chain, PublicClient } from 'viem'
export { createPublicClient, http } from 'viem'
export {
  arbitrum,
  arbitrumSepolia,
  avalanche,
  avalancheFuji,
  base,
  baseSepolia,
  bsc,
  bscTestnet,
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
