import { X } from 'lucide-react'
import * as React from 'react'
import { type Address } from 'viem'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

interface Split {
  recipient: Address
  amount: string
}

function safeBigInt(s: string): bigint | null {
  if (s.trim() === '') return null
  try {
    return BigInt(s)
  } catch {
    return null
  }
}

interface Props {
  splits: Split[]
  setSplits: (next: Split[]) => void
  totalBaseUnits: string
}

/**
 * Per-keystroke recipient/amount updates refresh the primary-amount
 * preview WITHOUT rebuilding the list DOM. With React + controlled inputs
 * keyed by index this is automatic — typing into row #2 just re-renders
 * that row's value attribute, not the list children.
 */
export function SplitsEditor({ splits, setSplits, totalBaseUnits }: Props): JSX.Element {
  // Primary preview = total - sum(splits). Recompute on every render.
  let primary: string = '⚠ invalid input'
  const total = safeBigInt(totalBaseUnits)
  if (total !== null) {
    let sum = 0n
    let anyInvalid = false
    for (const s of splits) {
      const v = safeBigInt(s.amount)
      if (v === null) {
        anyInvalid = true
        break
      }
      sum += v
    }
    if (!anyInvalid) {
      const p = total - sum
      primary = p >= 0n ? p.toString() : '⚠ over'
    }
  }

  const updateAt = (i: number, patch: Partial<Split>): void => {
    const next = splits.slice()
    next[i] = { ...next[i]!, ...patch }
    setSplits(next)
  }
  const removeAt = (i: number): void => {
    const next = splits.slice()
    next.splice(i, 1)
    setSplits(next)
  }
  const add = (): void => {
    setSplits([
      ...splits,
      {
        recipient: '0x3333333333333333333333333333333333333333' as Address,
        amount: '100000',
      },
    ])
  }

  return (
    <Card>
      <CardContent className="space-y-2 p-5">
        <div className="flex items-center justify-between">
          <div className="text-xs font-medium text-muted-foreground">
            Permit2 splits (batch path) — primary recipient receives{' '}
            <span className="font-mono text-primary">{primary}</span>
          </div>
          <Button
            variant="link"
            size="sm"
            onClick={add}
            className="h-auto p-0 text-xs text-primary"
          >
            + Add split
          </Button>
        </div>
        <div className="space-y-2">
          {splits.map((split, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                value={split.recipient}
                onChange={(e) => updateAt(i, { recipient: e.target.value as Address })}
                placeholder="0x..."
                className="flex-1 font-mono text-xs"
              />
              <Input
                value={split.amount}
                onChange={(e) => updateAt(i, { amount: e.target.value })}
                placeholder="base units"
                className="w-32 font-mono text-xs"
              />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => removeAt(i)}
                className="text-muted-foreground hover:text-red-400"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
