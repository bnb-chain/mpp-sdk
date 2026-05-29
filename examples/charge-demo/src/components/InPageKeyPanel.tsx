import { KeyRound } from 'lucide-react'
import * as React from 'react'
import { type LocalAccount } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

interface Props {
  account: LocalAccount | null
  onGenerate: (account: LocalAccount) => void
}

export function InPageKeyPanel({ account, onGenerate }: Props): JSX.Element {
  const handleGenerate = (): void => {
    const pk = generatePrivateKey()
    onGenerate(privateKeyToAccount(pk))
  }

  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <Button variant="secondary" onClick={handleGenerate} className="gap-2">
          <KeyRound className="h-4 w-4" />
          Generate in-page key
        </Button>
        <div className="min-w-0 flex-1 text-xs text-muted-foreground">
          {account ? (
            <span className="block truncate font-mono">
              <span className="text-primary">{account.address}</span>
              <span className="text-muted-foreground"> (in-page demo key)</span>
            </span>
          ) : (
            <span>
              No in-page key yet — this fallback is used when MetaMask can't sign (e.g. pre-signed
              EIP-1559 RLP for the transaction credential).
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
