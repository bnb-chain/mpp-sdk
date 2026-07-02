import * as React from 'react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { CREDENTIAL_META, type CredentialType } from '@/protocol/presets.js'

export function RealismCallout({ type }: { type: CredentialType }): JSX.Element {
  const meta = CREDENTIAL_META[type]
  const variant: 'success' | 'info' | 'warn' = meta.settlesOnChain
    ? 'success'
    : meta.realism.startsWith('REAL')
      ? 'info'
      : 'warn'
  return (
    <Alert variant={variant}>
      <div className="flex items-start gap-2.5">
        <span className="text-lg leading-none">{meta.icon}</span>
        <div className="flex-1 space-y-1">
          <AlertTitle>{meta.title}</AlertTitle>
          <AlertDescription className="text-muted-foreground">{meta.blurb}</AlertDescription>
          <div className="pt-1 text-xs">
            <span className="font-mono uppercase tracking-wider text-muted-foreground">
              Realism:
            </span>{' '}
            <span>{meta.realism}</span>
          </div>
        </div>
      </div>
    </Alert>
  )
}
