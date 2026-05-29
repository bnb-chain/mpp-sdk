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
import { Switch } from '@/components/ui/switch'
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
  serverMode: boolean
  setServerMode: (v: boolean) => void
  serverEndpoint: string
  setServerEndpoint: (v: string) => void
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
    setServerMode,
    serverEndpoint,
    setServerEndpoint,
  } = props

  // Server-managed fields are locked (chain / recipient / realm / amount).
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

        <Separator />

        {/* End-to-end mode row */}
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <Switch checked={serverMode} onCheckedChange={setServerMode} id="server-mode" />
            <Label htmlFor="server-mode" className="text-xs font-medium">
              End-to-end mode — fetch real 402 + submit credential to charge-server
            </Label>
          </div>
          {serverMode && (
            <div className="space-y-1.5 pl-12">
              <Label className="text-xs font-medium text-muted-foreground">
                Server endpoint (Vite proxies <span className="font-mono text-primary">/api</span> →{' '}
                <span className="font-mono text-primary">localhost:3000</span>)
              </Label>
              <Input
                value={serverEndpoint}
                onChange={(e) => setServerEndpoint(e.target.value)}
                className="font-mono"
              />
              <div className="text-[11px] leading-relaxed text-muted-foreground">
                When end-to-end mode is on: binding-mode is forced to{' '}
                <span className="font-mono text-primary">mppx-managed</span>, and chain / token /
                recipient / amount come from the server's 402 (your form values for those fields are
                overwritten on step&nbsp;1).
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
