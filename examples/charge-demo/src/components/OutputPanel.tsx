import { ChevronRight, CircleAlert, CircleCheck, Info } from 'lucide-react'
import * as React from 'react'

import { type OutputPanel as OutputPanelData } from '@/state/types'

function StatusIcon({ status }: { status: OutputPanelData['status'] }): JSX.Element {
  switch (status) {
    case 'ok':
      return <CircleCheck className="h-4 w-4 text-emerald-400" />
    case 'warn':
      return <CircleAlert className="h-4 w-4 text-amber-400" />
    case 'info':
      return <Info className="h-4 w-4 text-sky-400" />
  }
}

function borderFor(status: OutputPanelData['status']): string {
  switch (status) {
    case 'ok':
      return 'border-emerald-700/40'
    case 'warn':
      return 'border-amber-700/40'
    case 'info':
      return 'border-sky-700/40'
  }
}

export function OutputPanel({ panels }: { panels: OutputPanelData[] }): JSX.Element {
  if (panels.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm italic text-muted-foreground">
        Nothing yet — pick a tab, configure, then run a step (or{' '}
        <strong className="not-italic text-primary">⚡ Run All</strong>).
      </div>
    )
  }
  return (
    <div className="space-y-3">
      {panels.map((p, i) => (
        <details
          key={p.id}
          className={`group animate-in fade-in slide-in-from-bottom-2 overflow-hidden rounded-xl border bg-card/40 duration-200 ${borderFor(p.status)}`}
        >
          <summary className="flex cursor-pointer items-center gap-2 px-5 py-3 hover:bg-card/80">
            <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-90" />
            <span className="font-mono text-xs text-muted-foreground">
              #{String(i + 1).padStart(2, '0')}
            </span>
            <StatusIcon status={p.status} />
            <span className="flex-1 font-semibold text-foreground">{p.title}</span>
          </summary>
          <div className="px-5 pb-4 pt-1">{p.body}</div>
        </details>
      ))}
    </div>
  )
}
