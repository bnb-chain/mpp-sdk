import * as React from 'react'
import { useAccount, useBalance, useChainId } from 'wagmi'

import { CHAIN_PRESETS, explorerAddressUrl } from '@/protocol/presets.js'

function shortAddr(addr: string | null | undefined): string {
  if (!addr) return '—'
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

export function StatusBar(): JSX.Element | null {
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const { data: balance } = useBalance({ address })

  if (!isConnected || !address) return null

  const preset = CHAIN_PRESETS.find((p) => p.chainId === chainId)
  const chainLabel = preset ? preset.label.replace(/ \(.*$/, '') : `chainId=${chainId}`
  const explorerAddr = explorerAddressUrl(chainId, address)

  const balanceStr = balance
    ? `${Number.parseFloat(balance.formatted).toFixed(4)} ${balance.symbol}`
    : '…'

  return (
    <div className="mx-auto flex max-w-6xl items-center gap-3 border-b border-border px-6 py-2 text-xs text-muted-foreground">
      <span className="text-emerald-400">●</span>
      <span className="font-mono">{chainLabel}</span>
      <span className="text-border">·</span>
      {explorerAddr ? (
        <a
          href={explorerAddr}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono hover:text-primary hover:underline"
        >
          {shortAddr(address)}
        </a>
      ) : (
        <span className="font-mono">{shortAddr(address)}</span>
      )}
      <span className="text-border">·</span>
      <span>{balanceStr}</span>
      {preset?.faucetUrl && (
        <a
          href={preset.faucetUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto text-primary hover:underline"
        >
          Faucet ↗
        </a>
      )}
    </div>
  )
}
