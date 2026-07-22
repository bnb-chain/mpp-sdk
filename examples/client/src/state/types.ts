import { type B402ChargeTransferMethod } from '@bnb-chain/mpp-b402'
import { type Challenge } from 'mppx'
import { type Address, type Hex } from 'viem'

export type B402Path = B402ChargeTransferMethod
export type StepState = 'idle' | 'running' | 'ok' | 'err'
export type PanelStatus = 'ok' | 'info' | 'warn'

export interface OutputPanel {
  id: number
  title: string
  status: PanelStatus
  body: React.ReactNode
}

export interface ExecState {
  challenge: Challenge.Challenge | null
  credential: string | null
  settlementTxHash: Hex | null
  recovered: Address | null
  receiptHeader: string | null
  panels: OutputPanel[]
  stepStates: [StepState, StepState, StepState, StepState]
}

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

export interface DemoState {
  path: B402Path
  challenge: Challenge.Challenge | null
  credential: string | null
  settlementTxHash: Hex | null
  recovered: Address | null
  receiptHeader: string | null
}
