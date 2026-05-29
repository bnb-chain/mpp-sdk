/**
 * Server-driven config panel.
 *
 * In server mode the demo fetches the charge-server's `/api/config` and shows
 * what that deployment ACTUALLY accepts — chain / token / currency /
 * credentialTypes / recipient / routes — instead of assuming it from the
 * static client-side presets. The server derives this from the SDK's own
 * `preflightCharge(...)._resolved`, so there's a single source of truth.
 *
 * (The multi-chain selector elsewhere is a local wire-shape inspect tool; a
 * real server offers exactly one (chain, token), which is what this shows.)
 */

import { CircleCheck, Server, ShieldAlert } from 'lucide-react'
import * as React from 'react'

import { Card, CardContent } from '@/components/ui/card'

/** Per-route descriptor in the `/api/config` response. */
interface RouteDescriptor {
  path: string
  credentialTypes: string[]
  challengeBinding: 'mppx-managed' | 'stored-lookup'
  hasSplits: boolean
  canSettle: boolean
  amountPolicy: string
}

/** Shape of the charge-server `/api/config` response. */
interface DeploymentConfig {
  chain: string
  chainId: number
  token: string
  currency: string
  decimals: number
  credentialTypes: string[]
  permit2Address: string
  recipient: string
  canSettle: boolean
  explorerUrl: string
  routes: RouteDescriptor[]
}

/** Derive the `/api/config` URL from the configured charge endpoint. */
function configUrlFor(serverEndpoint: string): string {
  try {
    const u = new URL(serverEndpoint, window.location.origin)
    u.pathname = '/api/config'
    u.search = ''
    return u.toString()
  } catch {
    return '/api/config'
  }
}

export function ServerConfigPanel({
  serverEndpoint,
  enabled,
}: {
  serverEndpoint: string
  enabled: boolean
}): JSX.Element | null {
  const [config, setConfig] = React.useState<DeploymentConfig | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!enabled) {
      setConfig(null)
      setError(null)
      return
    }
    let cancelled = false
    setError(null)
    void fetch(configUrlFor(serverEndpoint))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((c: DeploymentConfig) => {
        if (!cancelled) setConfig(c)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [serverEndpoint, enabled])

  if (!enabled) return null

  if (error) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
          <ShieldAlert className="h-4 w-4 text-amber-400" />
          Couldn't reach <code className="font-mono">/api/config</code> ({error}). Is the
          charge-server running? Vite proxies <code className="font-mono">/api</code> →
          localhost:3000.
        </CardContent>
      </Card>
    )
  }

  if (!config) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
          <Server className="h-4 w-4" />
          Loading server config…
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="border-emerald-700/40 bg-emerald-950/20">
      <CardContent className="space-y-1.5 p-3 text-xs">
        <div className="flex items-center gap-2 font-semibold text-emerald-300">
          <CircleCheck className="h-4 w-4" />
          Server config (from <code className="font-mono">/api/config</code>)
        </div>
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-muted-foreground">
          <span>chain</span>
          <span className="text-foreground">
            {config.chain} ({config.chainId})
          </span>
          <span>token</span>
          <span className="text-foreground">
            {config.token} · {config.decimals} dec
          </span>
          <span>currency</span>
          <span className="break-all text-foreground">{config.currency}</span>
          <span>recipient</span>
          <span className="break-all text-foreground">{config.recipient}</span>
          <span>credentialTypes</span>
          <span className="text-foreground">{config.credentialTypes.join(', ')}</span>
          <span>settles</span>
          <span className="text-foreground">
            {config.canSettle ? 'on-chain' : 'wire-shape only'}
          </span>
        </div>
        <div className="space-y-1 pt-1">
          <div className="font-mono text-muted-foreground">routes (per-route detail)</div>
          {config.routes.map((rt) => (
            <div
              key={rt.path}
              className="rounded border border-emerald-800/30 bg-black/20 p-1.5 font-mono"
            >
              <div className="flex items-center justify-between gap-2">
                <code className="text-foreground">{rt.path}</code>
                <span className="text-[10px] text-muted-foreground">{rt.amountPolicy}</span>
              </div>
              <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-muted-foreground">
                <span className="text-foreground/80">{rt.credentialTypes.join(', ')}</span>
                <span>· {rt.challengeBinding}</span>
                {rt.hasSplits ? <span>· splits</span> : null}
                <span>· {rt.canSettle ? 'settles' : 'payer-funded'}</span>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
