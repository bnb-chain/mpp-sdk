import { bsc, bscTestnet } from 'viem/chains'

export interface ChainPresentation {
  chainId: number
  explorerUrl: string
  faucetUrl?: string
  label: string
}

export const CHAIN_PRESETS: readonly ChainPresentation[] = [
  {
    chainId: bscTestnet.id,
    explorerUrl: 'https://testnet.bscscan.com',
    faucetUrl: 'https://www.bnbchain.org/en/testnet-faucet',
    label: 'BSC Testnet',
  },
  {
    chainId: bsc.id,
    explorerUrl: 'https://bscscan.com',
    label: 'BSC Mainnet',
  },
]

export function explorerTxUrl(chainId: number, txHash: string): string | null {
  const chain = CHAIN_PRESETS.find((candidate) => candidate.chainId === chainId)
  return chain ? `${chain.explorerUrl}/tx/${txHash}` : null
}

export function explorerAddressUrl(chainId: number, address: string): string | null {
  const chain = CHAIN_PRESETS.find((candidate) => candidate.chainId === chainId)
  return chain ? `${chain.explorerUrl}/address/${address}` : null
}
