import * as React from 'react'

import { type VerifyLine } from '@/state/types'

function colorFor(ok: VerifyLine['ok']): string {
  if (ok === 'skipped') return 'text-muted-foreground font-mono'
  return ok ? 'font-mono text-emerald-400' : 'font-mono text-red-400'
}

export function VerifyList({ lines }: { lines: VerifyLine[] }): JSX.Element {
  return (
    <ul className="space-y-2 text-sm">
      {lines.map((l, i) => (
        <li key={i}>
          {l.label && <>• {l.label}: </>}
          {l.label === '' ? (
            <span className="text-muted-foreground">{l.detail}</span>
          ) : (
            <>
              <span className={colorFor(l.ok)}>
                {l.ok === 'skipped' ? 'skipped' : String(l.ok)}
              </span>
              {l.detail && (
                <span className="ml-2 text-muted-foreground">
                  {l.ok === 'skipped' ? `(${l.detail})` : `— ${l.detail}`}
                </span>
              )}
            </>
          )}
        </li>
      ))}
    </ul>
  )
}
