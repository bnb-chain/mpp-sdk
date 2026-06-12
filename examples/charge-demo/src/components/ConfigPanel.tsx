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
import { type BindingMode } from '@/state/types'

interface Props {
  chainKey: string
  setChainKey: (v: string) => void
  bindingMode: BindingMode
  setBindingMode: (v: BindingMode) => void
  amountDecimal: string
  setAmountDecimal: (v: string) => void
  amountBase: string
  recipient: string
  setRecipient: (v: string) => void
  realm: string
  setRealm: (v: string) => void
  /** End-to-end (charge-server) mode. Always on in this build — the toggle is
   *  hidden, but the flag still drives the server-managed field locks. */
  serverMode: boolean
  serverEndpoint: string
}

const lockedClass = 'opacity-60 cursor-not-allowed'

export function ConfigPanel(props: Props): JSX.Element {
  const {
    chainKey,
    setChainKey,
    bindingMode,
    setBindingMode,
    amountDecimal,
    setAmountDecimal,
    amountBase,
    recipient,
    setRecipient,
    realm,
    setRealm,
    serverMode,
    serverEndpoint,
  } = props

  // In end-to-end mode chain / token / recipient / amount / realm come from
  // the server's 402 challenge, so the form fields are read-only mirrors.
  const fieldLockTitle = serverMode
    ? 'Server-managed in end-to-end mode — value comes from the 402 challenge.'
    : undefined

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        {/* Row 1: chain · binding · amount */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">Chain</Label>
            <Select value={chainKey} onValueChange={setChainKey} disabled={serverMode}>
              <SelectTrigger
                className={serverMode ? lockedClass : undefined}
                title={fieldLockTitle}
              >
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
              Challenge binding mode
            </Label>
            <Select
              value={bindingMode}
              onValueChange={(v) => setBindingMode(v as BindingMode)}
              disabled={serverMode}
            >
              <SelectTrigger className={serverMode ? lockedClass : undefined}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mppx-hmac">mppx-hmac (bare verify path)</SelectItem>
                <SelectItem value="mppx-managed">mppx-managed (under Mppx.create)</SelectItem>
                <SelectItem value="stored-lookup">
                  stored-lookup (draft §6 zero-deviation)
                </SelectItem>
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
              onChange={(e) => setAmountDecimal(e.target.value)}
              className={`font-mono ${serverMode ? lockedClass : ''}`}
              readOnly={serverMode}
              title={fieldLockTitle}
            />
          </div>
        </div>

        {/* Row 2: recipient · realm */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">Recipient address</Label>
            <Input
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              className={`font-mono ${serverMode ? lockedClass : ''}`}
              readOnly={serverMode}
              title={fieldLockTitle}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">
              Realm (challenge origin)
            </Label>
            <Input
              value={realm}
              onChange={(e) => setRealm(e.target.value)}
              className={`font-mono ${serverMode ? lockedClass : ''}`}
              readOnly={serverMode}
              title={fieldLockTitle}
            />
          </div>
        </div>

        {serverMode && (
          <>
            <Separator />
            <div className="flex items-center gap-2 text-[11px] leading-relaxed text-muted-foreground">
              <Server className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
              <span>
                End-to-end mode: this demo fetches a real <span className="font-mono">402</span>{' '}
                from <span className="font-mono text-primary">{serverEndpoint}</span> and submits
                the credential back to the charge-server for settlement. Chain / token / recipient /
                amount above mirror the server's challenge (read-only), and the binding mode is{' '}
                <span className="font-mono text-primary">mppx-managed</span>.
              </span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
