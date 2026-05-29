import { type Challenge } from 'mppx'
import { type Address, type Hex, type LocalAccount } from 'viem'

import { type CredentialType } from '@/protocol/presets.js'

/** Possible binding modes for the local-mode challenge issuer. */
export type BindingMode = 'mppx-managed' | 'mppx-hmac' | 'stored-lookup'

/** Status pill for each of the 4 demo steps. */
export type StepState = 'idle' | 'running' | 'ok' | 'err'

/** Status indicator for an output panel. */
export type PanelStatus = 'ok' | 'info' | 'warn'

/** Inline state line for the local-verify panel (label + result + optional detail). */
export interface VerifyLine {
  label: string
  ok: boolean | 'skipped'
  detail?: string
}

/** Rendered output panel (rendered as a collapsible details card). */
export interface OutputPanel {
  id: number
  title: string
  status: PanelStatus
  /** Content tree — we render via JSX rather than HTML strings for safety. */
  body: React.ReactNode
}

/**
 * Per-credential-type execution state. The 4 credential types each get
 * their own independent pool so flipping tabs never bleeds a stale
 * challenge / credential / settlementTxHash from one type into another,
 * and so step 3 never sees a not-yet-committed credential left by step 2.
 */
export interface ExecState {
  challenge: Challenge.Challenge | null
  credential: string | null
  settlementTxHash: Hex | null
  recovered: Address | null
  receiptHeader: string | null
  panels: OutputPanel[]
  stepStates: [StepState, StepState, StepState, StepState]
}

/**
 * Fresh per-type execution state. A factory (not a shared const) so every
 * pool gets its OWN `panels` array + `stepStates` tuple — spreading a shared
 * const (`{ ...INITIAL_EXEC_STATE }`) is a shallow copy that would alias
 * those nested arrays across all 4 pools.
 */
export function freshExecState(): ExecState {
  return {
    challenge: null,
    credential: null,
    settlementTxHash: null,
    recovered: null,
    receiptHeader: null,
    panels: [],
    stepStates: ['idle', 'idle', 'idle', 'idle'],
  }
}

/**
 * The flat snapshot passed to action functions. Composed by App.tsx by
 * merging shared form fields with the currently-active credential
 * type's ExecState pool. Actions never see the per-type pools directly —
 * they only ever see this flat view + return patches that App.tsx
 * routes back into the active pool.
 */
export interface DemoState {
  credentialType: CredentialType
  chainKey: string
  bindingMode: BindingMode
  amountDecimal: string
  recipient: Address
  realm: string
  splits: Array<{ recipient: Address; amount: string }>
  serverMode: boolean
  serverEndpoint: string
  // Per-type execution slice (challenge / credential / etc.) — comes
  // from the active pool, NOT from a single shared slot. Patches go
  // back into pools[credentialType] in App.tsx, not into a global.
  challenge: Challenge.Challenge | null
  credential: string | null
  settlementTxHash: Hex | null
  recovered: Address | null
  receiptHeader: string | null
  inPageAccount: LocalAccount | null
}
