import * as React from 'react'

import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CREDENTIAL_META, type CredentialType } from '@/protocol/presets.js'

export function CredentialTabsBar({
  value,
  types,
  onChange,
}: {
  value: CredentialType
  /** Credential tabs to surface — computed from the active chain preset. */
  types: readonly CredentialType[]
  onChange: (type: CredentialType) => void
}): JSX.Element {
  return (
    <Tabs value={value} onValueChange={(v) => onChange(v as CredentialType)}>
      <TabsList>
        {types.map((type) => {
          const meta = CREDENTIAL_META[type]
          return (
            <TabsTrigger key={type} value={type}>
              <span className="text-base leading-none">{meta.icon}</span>
              <span>{meta.title}</span>
            </TabsTrigger>
          )
        })}
      </TabsList>
    </Tabs>
  )
}
