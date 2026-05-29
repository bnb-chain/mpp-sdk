import { CircleCheck, ExternalLink, Loader2, ShieldAlert } from 'lucide-react'
import * as React from 'react'
import { type Address, formatUnits, maxUint256 } from 'viem'
import { useAccount, useChainId, usePublicClient, useWalletClient } from 'wagmi'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { type ChainPreset, PERMIT2_ADDRESS, explorerTxUrl } from '@/protocol/presets.js'

/**
 * Permit2 needs a one-time ERC-20 approval before it can pull tokens
 * from the user. Without it, the server-side settlement fails with:
 *
 *     ERC20.allowance(signer, permit2) 0 < totalAmount N
 *
 * This panel reads the current `ERC20.allowance(wallet, permit2)` and
 * either (a) shows a green ✓ "approved up to N" line when allowance
 * covers the current amount, or (b) shows a red "needs approval" line
 * + a button that prompts MetaMask for an `approve(permit2, max)` tx.
 *
 * Lives in the Permit2 tab only. After approval lands, allowance is
 * MAX_UINT256 so further Permit2 demos no-op past this check.
 */

const ERC20_ALLOWANCE_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const

interface Props {
  preset: ChainPreset
  amountBase: string
  /**
   * Permit2 contract to read/approve against. Comes from the active
   * challenge's `methodDetails.permit2Address` so approval targets the
   * SAME contract the server's settlement will call. Falls back to the
   * canonical Permit2 when no challenge has been issued yet.
   */
  permit2Address?: Address
}

type State =
  | { kind: 'idle' }
  | { kind: 'reading' }
  | { kind: 'ok'; allowance: bigint }
  | { kind: 'needs-approval'; allowance: bigint }
  | { kind: 'approving'; txHash?: `0x${string}` }
  | { kind: 'error'; message: string }

export function Permit2AllowancePanel({
  preset,
  amountBase,
  permit2Address,
}: Props): JSX.Element | null {
  const { address: walletAddress, isConnected } = useAccount()
  const walletChainId = useChainId()
  const publicClient = usePublicClient()
  const { data: walletClient } = useWalletClient()
  // The challenge's Permit2 contract, or the canonical address before a
  // challenge exists. This is the ERC-20 allowance spender + the approve
  // target — it MUST match the server's settlement Permit2 or the approval
  // is useless.
  const spender: Address = permit2Address ?? PERMIT2_ADDRESS
  const [state, setState] = React.useState<State>({ kind: 'idle' })
  // Bumped after a successful approve to trigger an allowance refetch
  // even when address / amount haven't changed.
  const [refreshTick, setRefreshTick] = React.useState(0)

  // Only read/approve when the wallet is actually on the selected
  // preset's chain AND that preset is settle-capable. Otherwise the
  // wagmi publicClient (bound to the connected chain) would read
  // `preset.currency` — a DIFFERENT chain's token address — and the
  // approve tx would write to the wrong chain. Mainnet "wire-shape
  // only" presets (canSettle === false) never get an actionable panel.
  const chainOk = preset.canSettle && walletChainId === preset.chainId

  const required = React.useMemo(() => {
    if (!amountBase || amountBase === 'invalid') return null
    try {
      return BigInt(amountBase)
    } catch {
      return null
    }
  }, [amountBase])

  // Read current allowance whenever wallet / chain / amount changes
  // (chain change implies preset change → currency address change).
  React.useEffect(() => {
    if (!isConnected || !walletAddress || !publicClient || !chainOk) {
      setState({ kind: 'idle' })
      return
    }
    if (required === null) {
      setState({ kind: 'idle' })
      return
    }
    let cancelled = false
    setState({ kind: 'reading' })
    void (async () => {
      try {
        const allowance = (await publicClient.readContract({
          address: preset.currency,
          abi: ERC20_ALLOWANCE_ABI,
          functionName: 'allowance',
          args: [walletAddress, spender],
        })) as bigint
        if (cancelled) return
        if (allowance >= required) {
          setState({ kind: 'ok', allowance })
        } else {
          setState({ kind: 'needs-approval', allowance })
        }
      } catch (e) {
        if (cancelled) return
        setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [
    isConnected,
    walletAddress,
    publicClient,
    preset.currency,
    spender,
    required,
    refreshTick,
    chainOk,
  ])

  const handleApprove = React.useCallback(async (): Promise<void> => {
    if (!walletClient || !walletAddress || !publicClient || !chainOk) return
    setState({ kind: 'approving' })
    try {
      const txHash = await walletClient.writeContract({
        address: preset.currency,
        abi: ERC20_ALLOWANCE_ABI,
        functionName: 'approve',
        args: [spender, maxUint256],
        account: walletAddress,
        chain: walletClient.chain ?? null,
      })
      setState({ kind: 'approving', txHash })
      await publicClient.waitForTransactionReceipt({ hash: txHash })
      setRefreshTick((n) => n + 1)
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }, [walletClient, walletAddress, publicClient, preset.currency, spender, chainOk])

  if (!isConnected) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 p-4 text-xs text-muted-foreground">
          <ShieldAlert className="h-4 w-4 text-amber-400" />
          Connect a wallet to check Permit2 allowance for{' '}
          <span className="font-mono text-primary">{preset.token}</span>.
        </CardContent>
      </Card>
    )
  }

  // Wallet connected but on the wrong chain (or a wire-shape-only preset
  // that can't settle). Show an info card instead of reading/approving
  // against the wrong chain.
  if (!chainOk) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 p-4 text-xs text-muted-foreground">
          <ShieldAlert className="h-4 w-4 text-amber-400" />
          {preset.canSettle ? (
            <span>
              Switch your wallet to <span className="font-mono text-primary">{preset.label}</span>{' '}
              (chainId {preset.chainId}) to check / approve Permit2 allowance. Currently on chainId{' '}
              <span className="font-mono">{walletChainId}</span>.
            </span>
          ) : (
            <span>
              <span className="font-mono text-primary">{preset.label}</span> is a wire-shape-only
              preset (no on-chain settlement in this demo) — Permit2 allowance approval is only
              available on settle-capable testnet presets (Sepolia).
            </span>
          )}
        </CardContent>
      </Card>
    )
  }

  // Loading / idle.
  if (state.kind === 'reading' || state.kind === 'idle') {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 p-4 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Reading <span className="font-mono">{preset.token}</span> allowance for Permit2…
        </CardContent>
      </Card>
    )
  }

  if (state.kind === 'error') {
    return (
      <Card>
        <CardContent className="space-y-1 p-4">
          <div className="flex items-center gap-2 text-xs text-red-400">
            <ShieldAlert className="h-4 w-4" />
            Allowance check failed
          </div>
          <pre className="whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
            {state.message}
          </pre>
        </CardContent>
      </Card>
    )
  }

  if (state.kind === 'ok') {
    const human = formatUnits(state.allowance, preset.decimals)
    const display = state.allowance >= 10n ** 30n ? '≈ ∞ (max uint256)' : `${human} ${preset.token}`
    return (
      <Card className="border-emerald-700/40 bg-emerald-950/20">
        <CardContent className="flex items-center gap-3 p-4 text-xs">
          <CircleCheck className="h-4 w-4 text-emerald-400" />
          <span className="text-emerald-300">Permit2 is approved</span>
          <span className="text-muted-foreground">·</span>
          <span className="font-mono text-muted-foreground">allowance = {display}</span>
        </CardContent>
      </Card>
    )
  }

  if (state.kind === 'approving') {
    const link = state.txHash ? explorerTxUrl(preset.chainId, state.txHash) : null
    return (
      <Card className="border-sky-700/40 bg-sky-950/20">
        <CardContent className="flex items-center gap-3 p-4 text-xs">
          <Loader2 className="h-4 w-4 animate-spin text-sky-400" />
          <span className="text-sky-300">
            {state.txHash ? 'Waiting for confirmation…' : 'Confirm in MetaMask…'}
          </span>
          {link && (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto inline-flex items-center gap-1 text-primary hover:underline"
            >
              View tx <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </CardContent>
      </Card>
    )
  }

  // needs-approval
  return (
    <Card className="border-amber-700/40 bg-amber-950/20">
      <CardContent className="flex flex-wrap items-center gap-3 p-4">
        <ShieldAlert className="h-4 w-4 shrink-0 text-amber-400" />
        <div className="min-w-0 flex-1 space-y-0.5 text-xs">
          <div className="font-semibold text-amber-200">
            Permit2 needs a one-time approval for <span className="font-mono">{preset.token}</span>
          </div>
          <div className="text-muted-foreground">
            Current allowance: <span className="font-mono">{state.allowance.toString()}</span> &lt;
            required: <span className="font-mono">{required?.toString()}</span>. Without this,
            server-side <code className="font-mono">permitWitnessTransferFrom</code> fails on-chain.
            Approval is per-token, per-wallet, one-time (gas ~50k).
          </div>
        </div>
        <Button onClick={() => void handleApprove()} className="gap-2">
          <ShieldAlert className="h-4 w-4" />
          Approve Permit2
        </Button>
      </CardContent>
    </Card>
  )
}
