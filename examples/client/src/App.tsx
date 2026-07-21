import { type B402ChargeRequest } from '@bnb-chain/mpp/b402'
import { ArrowRight, FileSignature, ShieldCheck } from 'lucide-react'
import * as React from 'react'
import { useCallback, useState } from 'react'
import { type Address } from 'viem'
import { useAccount, useChainId, usePublicClient, useWalletClient } from 'wagmi'

import * as actions from '@/actions'
import { Header } from '@/components/Header'
import { OutputPanel } from '@/components/OutputPanel'
import { StatusBar } from '@/components/StatusBar'
import { StepBar, StepButtons } from '@/components/StepBar'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  type B402Path,
  type DemoState,
  type ExecState,
  freshExecState,
  type StepState,
} from '@/state/types'

type Pools = Record<B402Path, ExecState>

const PATHS: readonly B402Path[] = ['eip3009', 'permit2-exact']
const STEP_LABELS: [string, string, string, string] = [
  '1 · Fetch challenge',
  '2 · Sign credential',
  '3 · Local verify',
  '4 · Submit & settle',
]
const BUTTON_LABELS: [string, string, string, string] = [
  'Fetch Challenge',
  'Sign Credential',
  'Verify Locally',
  'Submit & Settle',
]

function freshPools(): Pools {
  return { eip3009: freshExecState(), 'permit2-exact': freshExecState() }
}

function snapshot(path: B402Path, state: ExecState): DemoState {
  return {
    path,
    challenge: state.challenge,
    credential: state.credential,
    settlementTxHash: state.settlementTxHash,
    recovered: state.recovered,
    receiptHeader: state.receiptHeader,
  }
}

export function App(): JSX.Element {
  const [path, setPath] = useState<B402Path>('eip3009')
  const [pools, setPools] = useState<Pools>(freshPools)
  const active = pools[path]
  const { address, isConnected } = useAccount()
  const walletChainId = useChainId()
  const { data: walletClient } = useWalletClient()
  const publicClient = usePublicClient()

  const setStep = useCallback((target: B402Path, index: 0 | 1 | 2 | 3, state: StepState): void => {
    setPools((previous) => {
      const stepStates = [...previous[target].stepStates] as ExecState['stepStates']
      stepStates[index] = state
      return { ...previous, [target]: { ...previous[target], stepStates } }
    })
  }, [])

  const applyResult = useCallback((target: B402Path, result: actions.ActionResult): void => {
    setPools((previous) => {
      const current = previous[target]
      const next: ExecState = {
        ...current,
        panels: [...current.panels, result.panel],
      }
      if (result.patch.challenge !== undefined) next.challenge = result.patch.challenge
      if (result.patch.credential !== undefined) next.credential = result.patch.credential
      if (result.patch.recovered !== undefined) next.recovered = result.patch.recovered
      if (result.patch.receiptHeader !== undefined) next.receiptHeader = result.patch.receiptHeader
      if (result.patch.settlementTxHash !== undefined) {
        next.settlementTxHash = result.patch.settlementTxHash
      }
      return { ...previous, [target]: next }
    })
  }, [])

  const runStep = useCallback(
    async (
      target: B402Path,
      index: 0 | 1 | 2 | 3,
      errorTitle: string,
      operation: () => Promise<actions.ActionResult>,
    ): Promise<actions.ActionResult | null> => {
      setStep(target, index, 'running')
      try {
        const result = await operation()
        applyResult(target, result)
        setStep(target, index, 'ok')
        return result
      } catch (error) {
        applyResult(target, { panel: actions.errorPanel(errorTitle, error), patch: {} })
        setStep(target, index, 'err')
        return null
      }
    },
    [applyResult, setStep],
  )

  const buildContext = useCallback(
    (): actions.BuildCredentialContext => ({
      publicClient: publicClient ?? null,
      walletAddress: address ?? null,
      walletChainId: walletChainId ?? null,
      walletClient: walletClient ?? null,
    }),
    [address, publicClient, walletChainId, walletClient],
  )

  const runFetch = useCallback(
    (state = snapshot(path, active)) =>
      runStep(path, 0, 'Fetch Challenge failed', () => actions.fetchB402Challenge(state)),
    [active, path, runStep],
  )
  const runSign = useCallback(
    (state = snapshot(path, active)) =>
      runStep(path, 1, 'Sign Credential failed', () =>
        actions.buildB402Credential(state, buildContext()),
      ),
    [active, buildContext, path, runStep],
  )
  const runVerify = useCallback(
    (state = snapshot(path, active)) =>
      runStep(path, 2, 'Local Verification failed', () => actions.verifyB402Local(state)),
    [active, path, runStep],
  )
  const runSubmit = useCallback(
    (state = snapshot(path, active)) =>
      runStep(path, 3, 'Submit & Settle failed', () => actions.submitB402Credential(state)),
    [active, path, runStep],
  )

  const clear = useCallback((): void => {
    setPools((previous) => ({ ...previous, [path]: freshExecState() }))
  }, [path])

  const runAll = useCallback(async (): Promise<void> => {
    const clean = freshExecState()
    setPools((previous) => ({ ...previous, [path]: clean }))
    let state = snapshot(path, clean)

    const challenge = await runStep(path, 0, 'Fetch Challenge failed', () =>
      actions.fetchB402Challenge(state),
    )
    if (!challenge) return
    state = { ...state, ...challenge.patch }

    const credential = await runStep(path, 1, 'Sign Credential failed', () =>
      actions.buildB402Credential(state, buildContext()),
    )
    if (!credential) return
    state = { ...state, ...credential.patch }

    const verified = await runStep(path, 2, 'Local Verification failed', () =>
      actions.verifyB402Local(state),
    )
    if (!verified) return
    state = { ...state, ...verified.patch }

    await runStep(path, 3, 'Submit & Settle failed', () => actions.submitB402Credential(state))
  }, [buildContext, path, runStep])

  const running = Object.values(pools).some((pool) => pool.stepStates.includes('running'))
  const disabled: [boolean, boolean, boolean, boolean] = [
    running,
    running || !active.challenge || !isConnected,
    running || !active.credential,
    running || !active.recovered,
  ]

  return (
    <div className="min-h-screen">
      <Header />
      <StatusBar />
      <main className="mx-auto max-w-6xl space-y-6 px-6 py-8">
        <section className="space-y-3">
          <p className="font-mono text-xs uppercase tracking-[0.25em] text-primary">
            MPP-native provider extension
          </p>
          <h1 className="text-3xl font-extrabold tracking-tight">B402 payment paths</h1>
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
            One MPP <code>b402/charge</code> interface, two facilitator-backed settlement methods.
            The server-issued Challenge is the source of truth for network, token, amount and
            recipient.
          </p>
        </section>

        <div className="grid gap-3 sm:grid-cols-2">
          {PATHS.map((candidate) => {
            const selected = candidate === path
            return (
              <Button
                key={candidate}
                className="h-auto justify-start p-4 text-left"
                disabled={running}
                onClick={() => setPath(candidate)}
                variant={selected ? 'default' : 'outline'}
              >
                {candidate === 'eip3009' ? (
                  <FileSignature className="h-5 w-5" />
                ) : (
                  <ShieldCheck className="h-5 w-5" />
                )}
                <span>
                  <span className="block font-bold">
                    {candidate === 'eip3009' ? 'B402 · EIP-3009' : 'B402 · Permit2 Exact'}
                  </span>
                  <span className="block whitespace-normal text-xs opacity-75">
                    {candidate === 'eip3009'
                      ? 'Sign transferWithAuthorization; no approval transaction.'
                      : 'Approve canonical Permit2 when needed, then sign PermitWitnessTransferFrom.'}
                  </span>
                </span>
              </Button>
            )
          })}
        </div>

        <PathSummary path={path} state={active} />

        <Card>
          <CardContent className="space-y-4 p-5">
            <StepBar
              onClear={clear}
              onRunAll={() => void runAll()}
              runAllDisabled={running || !isConnected}
              stepLabels={STEP_LABELS}
              stepStates={active.stepStates}
            />
            <StepButtons
              disabled={disabled}
              labels={BUTTON_LABELS}
              onClick={[
                () => void runFetch(),
                () => void runSign(),
                () => void runVerify(),
                () => void runSubmit(),
              ]}
            />
          </CardContent>
        </Card>

        <section className="space-y-3">
          <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-muted-foreground">
            Output <ArrowRight className="h-3 w-3" /> {path}
          </div>
          <OutputPanel panels={active.panels} />
        </section>
      </main>
    </div>
  )
}

function PathSummary({ path, state }: { path: B402Path; state: ExecState }): JSX.Element {
  const endpoint = actions.b402Endpoint(path)
  if (!state.challenge) {
    return (
      <Card className="border-sky-800/50 bg-sky-950/20">
        <CardContent className="p-5 text-sm text-muted-foreground">
          Endpoint: <code className="text-foreground">{endpoint}</code>. Fetch its signed Challenge
          to see the authoritative payment terms.
        </CardContent>
      </Card>
    )
  }

  const request = state.challenge.request as B402ChargeRequest
  const details = request.methodDetails
  return (
    <Card className={details.network === 'eip155:56' ? 'border-amber-600/60' : ''}>
      <CardContent className="grid gap-4 p-5 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <SummaryItem label="Network" value={details.network} />
        <SummaryItem label="Amount (atomic)" value={request.amount} />
        <SummaryItem label="Token" value={shortAddress(request.currency)} />
        <SummaryItem label="Recipient" value={shortAddress(request.recipient)} />
        <SummaryItem
          label="Token domain"
          value={`${details.eip712.name} / ${details.eip712.version}`}
        />
        <SummaryItem label="Facilitator signer" value={shortAddress(details.signerAddress)} />
        {details.spenderAddress && (
          <SummaryItem label="Permit2 spender" value={shortAddress(details.spenderAddress)} />
        )}
        <SummaryItem
          label="Settlement"
          value={details.network === 'eip155:56' ? 'MAINNET · REAL FUNDS' : path}
        />
      </CardContent>
    </Card>
  )
}

function SummaryItem({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="truncate font-mono text-xs" title={value}>
        {value}
      </div>
    </div>
  )
}

function shortAddress(value: Address): string {
  return `${value.slice(0, 8)}…${value.slice(-6)}`
}
