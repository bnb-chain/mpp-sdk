import { Check, Circle, Hourglass, Play, X, Zap } from 'lucide-react'
import * as React from 'react'

import { Button } from '@/components/ui/button'
import { type StepState } from '@/state/types'

interface Props {
  stepStates: [StepState, StepState, StepState, StepState]
  stepLabels: [string, string, string, string]
  runAllDisabled: boolean
  onRunAll: () => void
  onClear: () => void
}

function StepPill({ label, state }: { label: string; state: StepState }): JSX.Element {
  return (
    <div className="step-pill" data-state={state}>
      {state === 'idle' && <Circle className="h-3 w-3" />}
      {state === 'running' && <Hourglass className="h-3 w-3 pulse-icon" />}
      {state === 'ok' && <Check className="h-3 w-3" />}
      {state === 'err' && <X className="h-3 w-3" />}
      <span>{label}</span>
    </div>
  )
}

export function StepBar(props: Props): JSX.Element {
  const { stepStates, stepLabels, runAllDisabled, onRunAll, onClear } = props
  return (
    <div className="flex flex-wrap items-center gap-2">
      <StepPill label={stepLabels[0]} state={stepStates[0]} />
      <div className="step-arrow" />
      <StepPill label={stepLabels[1]} state={stepStates[1]} />
      <div className="step-arrow" />
      <StepPill label={stepLabels[2]} state={stepStates[2]} />
      <div className="step-arrow" />
      <StepPill label={stepLabels[3]} state={stepStates[3]} />
      <div className="flex-1" />
      {/* Lock Run All + Clear to the same h-9 default so they share a
          baseline with the step pills. Clear was previously size="sm"
          (h-8), making it visibly shorter than Run All — same bug we
          fixed in the vanilla version (commit 8682348). Variant alone
          handles the visual distinction. */}
      <Button onClick={onRunAll} disabled={runAllDisabled} className="gap-1.5">
        <Zap className="h-4 w-4" />
        Run All
      </Button>
      <Button onClick={onClear} variant="secondary">
        Clear
      </Button>
    </div>
  )
}

interface ButtonsProps {
  labels: [string, string, string, string]
  disabled: [boolean, boolean, boolean, boolean]
  onClick: [() => void, () => void, () => void, () => void]
}

export function StepButtons({ labels, disabled, onClick }: ButtonsProps): JSX.Element {
  return (
    <div className="flex flex-wrap gap-2 text-xs">
      {labels.map((label, i) => (
        <Button
          key={i}
          variant="secondary"
          size="sm"
          disabled={disabled[i]}
          onClick={onClick[i]}
          className="gap-1.5"
        >
          <Play className="h-3 w-3" />
          {label}
        </Button>
      ))}
    </div>
  )
}
