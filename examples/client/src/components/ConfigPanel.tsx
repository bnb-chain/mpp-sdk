import { Server } from 'lucide-react'
import * as React from 'react'

import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { CHAIN_PRESETS } from '@/protocol/presets.js'

interface Props {
  chainKey: string
  setChainKey: (v: string) => void
  amountDecimal: string
  amountBase: string
  recipient: string
  realm: string
  serverEndpoint: string
}

const lockedClass = 'opacity-60 cursor-not-allowed'
const lockedTitle = "Server-managed — value comes from the server's 402 challenge."

/**
 * The chain preset is the ONE user-editable field: it picks which credential
 * tabs surface and which network's offer the x402 tab accepts. Everything
 * else (amount / recipient / realm) mirrors the server's 402 challenge and is
 * read-only — the wire is the source of truth.
 */
export function ConfigPanel(props: Props): JSX.Element {
  const { chainKey, setChainKey, amountDecimal, amountBase, recipient, realm, serverEndpoint } =
    props

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        {/* Row 1: chain · amount */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">Chain preset</Label>
            <Select value={chainKey} onValueChange={setChainKey}>
              <SelectTrigger title="Picks the visible tabs + which network's x402 offer this client accepts.">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CHAIN_PRESETS.map((p) => (
                  <SelectItem key={p.key} value={p.key}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">
              Amount (decimal) → <span className="font-mono text-primary">{amountBase}</span>{' '}
              <span className="text-muted-foreground">base units</span>
            </Label>
            <Input
              value={amountDecimal}
              readOnly
              className={`font-mono ${lockedClass}`}
              title={lockedTitle}
            />
          </div>
        </div>

        {/* Row 2: recipient · realm */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">Recipient address</Label>
            <Input
              value={recipient}
              readOnly
              className={`font-mono ${lockedClass}`}
              title={lockedTitle}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">
              Realm (challenge origin)
            </Label>
            <Input
              value={realm}
              readOnly
              className={`font-mono ${lockedClass}`}
              title={lockedTitle}
            />
          </div>
        </div>

        <Separator />
        <div className="flex items-center gap-2 text-[11px] leading-relaxed text-muted-foreground">
          <Server className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
          <span>
            End-to-end mode: this demo fetches a real <span className="font-mono">402</span> from{' '}
            <span className="font-mono text-primary">{serverEndpoint}</span> and submits the
            credential back to the server for settlement. Amount / recipient / realm mirror the
            server's challenge (read-only); the chain preset above is yours to switch.
          </span>
        </div>
      </CardContent>
    </Card>
  )
}
