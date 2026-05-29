import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type Address, type LocalAccount, isAddress } from 'viem'
import { useAccount, useChainId, usePublicClient, useWalletClient } from 'wagmi'

import * as actions from '@/actions'
import { ConfigPanel } from '@/components/ConfigPanel'
import { CredentialTabsBar } from '@/components/CredentialTabsBar'
import { FailureCases, type FailureBaseline } from '@/components/FailureCases'
import { Header } from '@/components/Header'
import { InPageKeyPanel } from '@/components/InPageKeyPanel'
import { OutputPanel } from '@/components/OutputPanel'
import { Permit2AllowancePanel } from '@/components/Permit2AllowancePanel'
import { RealismCallout } from '@/components/RealismCallout'
import { ServerConfigPanel } from '@/components/ServerConfigPanel'
import { SplitsEditor } from '@/components/SplitsEditor'
import { StatusBar } from '@/components/StatusBar'
import { StepBar, StepButtons } from '@/components/StepBar'
import { usePersistedBoolean, usePersistedString } from '@/hooks/usePersistedState'
import {
  CHAIN_PRESETS,
  STORAGE_KEYS,
  type CredentialType,
  getPresetByKey,
  savePersisted,
} from '@/protocol/presets.js'
import {
  type DemoState,
  type ExecState,
  freshExecState,
  type OutputPanel as OutputPanelData,
  type StepState,
} from '@/state/types'

const DEFAULT_RECIPIENT = '0x2222222222222222222222222222222222222222'
const DEFAULT_REALM = 'https://demo.example.com/'
const DEFAULT_AMOUNT = '1.0'
const DEFAULT_CHAIN_KEY = 'sepolia'
const DEFAULT_CREDENTIAL_TYPE: CredentialType = 'hash'
const DEFAULT_BINDING_MODE = 'mppx-hmac'
const DEFAULT_ENDPOINT = '/api/article'

type Pools = Record<CredentialType, ExecState>

/** Build a fresh set of 4 independent pools, each with its own arrays. */
function freshPools(): Pools {
  return {
    hash: freshExecState(),
    transaction: freshExecState(),
    permit2: freshExecState(),
    authorization: freshExecState(),
  }
}

export function App(): JSX.Element {
  // ── Persisted form state (shared across all credential types) ────────
  const [credentialType, setCredentialType] = usePersistedString<CredentialType>(
    STORAGE_KEYS.credentialType,
    DEFAULT_CREDENTIAL_TYPE,
  )
  const [chainKey, setChainKeyRaw] = usePersistedString<string>(
    STORAGE_KEYS.chainKey,
    DEFAULT_CHAIN_KEY,
  )
  const [bindingMode, setBindingModeRaw] = usePersistedString<DemoState['bindingMode']>(
    STORAGE_KEYS.bindingMode,
    DEFAULT_BINDING_MODE,
  )
  const [amountDecimal, setAmountDecimalRaw] = usePersistedString<string>(
    STORAGE_KEYS.amount,
    DEFAULT_AMOUNT,
  )
  const [recipient, setRecipientRaw] = usePersistedString<string>(
    STORAGE_KEYS.recipient,
    DEFAULT_RECIPIENT,
  )
  const [realm, setRealmRaw] = usePersistedString<string>(STORAGE_KEYS.realm, DEFAULT_REALM)
  const [serverMode, setServerModeRaw] = usePersistedBoolean(STORAGE_KEYS.serverMode, true)
  const [serverEndpoint, setServerEndpointRaw] = usePersistedString<string>(
    STORAGE_KEYS.serverEndpoint,
    DEFAULT_ENDPOINT,
  )

  // ── Non-persisted shared state ───────────────────────────────────────
  const [splits, setSplits] = useState<DemoState['splits']>([])
  const [inPageAccount, setInPageAccount] = useState<LocalAccount | null>(null)

  // ── Per-credential-type pools (challenge / credential / pills /
  //    output panels — fully independent per tab so switching tabs
  //    preserves each tab's own progress). ──────────────────────────
  const [pools, setPools] = useState<Pools>(freshPools)
  const active = pools[credentialType]

  // Wagmi hooks (unchanged).
  const { address: walletAddress, isConnected } = useAccount()
  const walletChainId = useChainId()
  const { data: walletClient } = useWalletClient()
  const publicClient = usePublicClient()

  /* -------------------------------------------------------------------- */
  /*  Reset orchestration                                                  */
  /* -------------------------------------------------------------------- */

  /** Reset ALL 4 pools — used when a form field that's bound into the
   *  challenge (chain / recipient / realm / amount / bindingMode /
   *  serverMode / serverEndpoint) changes. Any in-flight challenge for
   *  ANY type would be stale against the new field value. */
  const resetAllPools = useCallback((): void => {
    setPools(freshPools())
  }, [])

  /** Reset a single pool — used when something type-specific changes
   *  (e.g. splits, which only ride on Permit2). */
  const resetPool = useCallback((type: CredentialType): void => {
    setPools((prev) => ({ ...prev, [type]: freshExecState() }))
  }, [])

  // Wrap each form setter so we clear downstream pools on change. Without
  // this, a user could tweak the recipient mid-flow and Run All would
  // submit a credential signed against the OLD recipient (the cached
  // challenge), getting a confusing server rejection.
  const setChainKey = useCallback(
    (v: string) => {
      setChainKeyRaw(v)
      resetAllPools()
    },
    [setChainKeyRaw, resetAllPools],
  )
  const setBindingMode = useCallback(
    (v: DemoState['bindingMode']) => {
      setBindingModeRaw(v)
      resetAllPools()
    },
    [setBindingModeRaw, resetAllPools],
  )
  const setAmountDecimal = useCallback(
    (v: string) => {
      setAmountDecimalRaw(v)
      resetAllPools()
    },
    [setAmountDecimalRaw, resetAllPools],
  )
  const setRecipient = useCallback(
    (v: string) => {
      setRecipientRaw(v)
      resetAllPools()
    },
    [setRecipientRaw, resetAllPools],
  )
  const setRealm = useCallback(
    (v: string) => {
      setRealmRaw(v)
      resetAllPools()
    },
    [setRealmRaw, resetAllPools],
  )
  const setServerMode = useCallback(
    (v: boolean) => {
      setServerModeRaw(v)
      resetAllPools()
    },
    [setServerModeRaw, resetAllPools],
  )
  const setServerEndpoint = useCallback(
    (v: string) => {
      setServerEndpointRaw(v)
      resetAllPools()
    },
    [setServerEndpointRaw, resetAllPools],
  )

  // Splits change → only the Permit2 pool's challenge is invalidated
  // (splits ride only on Permit2 per spec §4.2.3).
  const setSplitsWithReset = useCallback(
    (next: DemoState['splits'] | ((prev: DemoState['splits']) => DemoState['splits'])) => {
      setSplits(next)
      resetPool('permit2')
    },
    [resetPool],
  )

  // Force binding mode to mppx-managed when server mode is on.
  useEffect(() => {
    if (serverMode && bindingMode !== 'mppx-managed') {
      setBindingModeRaw('mppx-managed')
    }
  }, [serverMode, bindingMode, setBindingModeRaw])

  // Tab switch only changes which pool is active — it does NOT touch
  // `splits`. Splits are Permit2-only: `issueChallengeLocal` includes them
  // only when credentialType === 'permit2' (and ignores stale splits
  // otherwise, no throw), and server mode sources splits from the 402, not
  // local state. So splits persist with the Permit2 pool and stay
  // consistent across tab switches.
  const handleTabChange = useCallback(
    (type: CredentialType) => {
      setCredentialType(type)
    },
    [setCredentialType],
  )

  /* -------------------------------------------------------------------- */
  /*  DemoState snapshot — composed from shared form + ACTIVE pool         */
  /* -------------------------------------------------------------------- */

  const amountBase = useMemo(() => {
    return actions.recalcBaseUnits({
      chainKey,
      amountDecimal,
    } as DemoState)
  }, [chainKey, amountDecimal])

  // Permit2 contract advertised by the active challenge (if any). Passed to
  // the allowance panel so approval targets the same contract the server's
  // settlement will call; omitted (panel falls back to canonical) until a
  // challenge exists.
  const activePermit2Address = (
    active.challenge?.request as { methodDetails?: { permit2Address?: Address } } | undefined
  )?.methodDetails?.permit2Address

  // Baseline for the Failure cases panel — only when recipient + amount are
  // valid (each case mutates this valid baseline to construct its failure).
  const failureBaseline = useMemo<FailureBaseline | null>(() => {
    if (amountBase === 'invalid' || !isAddress(recipient)) return null
    return {
      preset: getPresetByKey(chainKey),
      recipient: recipient as Address,
      amountBaseUnits: amountBase,
      realm,
    }
  }, [amountBase, recipient, chainKey, realm])

  const buildSnapshot = useCallback(
    (): DemoState => ({
      credentialType,
      chainKey,
      bindingMode,
      amountDecimal,
      recipient: recipient as Address,
      realm,
      splits,
      serverMode,
      serverEndpoint,
      challenge: active.challenge,
      credential: active.credential,
      settlementTxHash: active.settlementTxHash,
      recovered: active.recovered,
      receiptHeader: active.receiptHeader,
      inPageAccount,
    }),
    [
      credentialType,
      chainKey,
      bindingMode,
      amountDecimal,
      recipient,
      realm,
      splits,
      serverMode,
      serverEndpoint,
      active,
      inPageAccount,
    ],
  )

  /* -------------------------------------------------------------------- */
  /*  Patch / step-state writers — all target the active pool              */
  /* -------------------------------------------------------------------- */

  const applyPatchToPool = useCallback((type: CredentialType, patch: Partial<DemoState>): void => {
    setPools((prev) => {
      const cur = prev[type]
      const next: ExecState = { ...cur }
      if (patch.challenge !== undefined) next.challenge = patch.challenge
      if (patch.credential !== undefined) next.credential = patch.credential
      if (patch.settlementTxHash !== undefined) next.settlementTxHash = patch.settlementTxHash
      if (patch.recovered !== undefined) next.recovered = patch.recovered
      if (patch.receiptHeader !== undefined) next.receiptHeader = patch.receiptHeader
      return { ...prev, [type]: next }
    })
    // inPageAccount is shared (not per-type) so write to top-level state.
    if (patch.inPageAccount !== undefined) setInPageAccount(patch.inPageAccount)
  }, [])

  const applyFormSync = useCallback(
    (sync: actions.ActionResult['formSync']): void => {
      if (!sync) return
      // Form-sync from fetchChallengeFromServer is a server-driven
      // form update — it MUST NOT trigger our setX wrappers' cascade
      // reset (that would wipe the challenge we just stored). Use the
      // raw setters.
      if (sync.chainKey !== undefined) setChainKeyRaw(sync.chainKey)
      if (sync.recipient !== undefined) setRecipientRaw(sync.recipient)
      if (sync.realm !== undefined) setRealmRaw(sync.realm)
      if (sync.amountDecimal !== undefined) setAmountDecimalRaw(sync.amountDecimal)
    },
    [setChainKeyRaw, setRecipientRaw, setRealmRaw, setAmountDecimalRaw],
  )

  const setStep = useCallback(
    (type: CredentialType, idx: 0 | 1 | 2 | 3, state: StepState): void => {
      setPools((prev) => {
        const cur = prev[type]
        const next = [...cur.stepStates] as ExecState['stepStates']
        next[idx] = state
        return { ...prev, [type]: { ...cur, stepStates: next } }
      })
    },
    [],
  )

  const pushPanel = useCallback((type: CredentialType, panelData: OutputPanelData): void => {
    setPools((prev) => ({
      ...prev,
      [type]: { ...prev[type], panels: [...prev[type].panels, panelData] },
    }))
  }, [])

  /* -------------------------------------------------------------------- */
  /*  Step runner — returns the patch so Run All can thread snapshots      */
  /*  through 1→2→3→4 without waiting for React re-renders.                */
  /* -------------------------------------------------------------------- */

  const runStep = useCallback(
    async (
      type: CredentialType,
      idx: 0 | 1 | 2 | 3,
      label: string,
      fn: () => Promise<actions.ActionResult> | actions.ActionResult,
    ): Promise<{
      ok: boolean
      patch?: Partial<DemoState>
      formSync?: actions.ActionResult['formSync']
    }> => {
      setStep(type, idx, 'running')
      try {
        const result = await fn()
        applyPatchToPool(type, result.patch)
        applyFormSync(result.formSync)
        pushPanel(type, result.panel)
        setStep(type, idx, 'ok')
        // Return formSync too so Run All can thread server-synced form
        // fields into the next step's snapshot synchronously (the
        // applyFormSync above updates React state, but that hasn't
        // committed across the awaited step chain — handleRunAll merges
        // this into its local snap). Without returning it, the merge in
        // handleRunAll reads undefined and step 2 builds against stale
        // pre-fetch chain / recipient / amount / realm.
        return { ok: true, patch: result.patch, formSync: result.formSync }
      } catch (err) {
        setStep(type, idx, 'err')
        pushPanel(type, actions.errorPanel(label, err))
        return { ok: false }
      }
    },
    [setStep, applyPatchToPool, applyFormSync, pushPanel],
  )

  /* -------------------------------------------------------------------- */
  /*  Step dispatchers — accept optional snap override so Run All can      */
  /*  thread state across steps without waiting for React re-renders.      */
  /* -------------------------------------------------------------------- */

  const step1 = useCallback(
    (
      override?: DemoState,
    ): Promise<{
      ok: boolean
      patch?: Partial<DemoState>
      formSync?: actions.ActionResult['formSync']
    }> => {
      const snap = override ?? buildSnapshot()
      return runStep(
        snap.credentialType,
        0,
        snap.serverMode ? 'Fetch challenge failed' : 'Issue challenge failed',
        () =>
          snap.serverMode
            ? actions.fetchChallengeFromServer(snap)
            : actions.issueChallengeLocal(snap),
      )
    },
    [buildSnapshot, runStep],
  )

  const step2 = useCallback(
    (
      override?: DemoState,
    ): Promise<{
      ok: boolean
      patch?: Partial<DemoState>
      formSync?: actions.ActionResult['formSync']
    }> => {
      const snap = override ?? buildSnapshot()
      return runStep(snap.credentialType, 1, 'Build credential failed', () =>
        actions.buildCredential(snap, {
          walletAddress: walletAddress ?? null,
          walletChainId: walletChainId ?? null,
          walletClient: walletClient ?? null,
          publicClient: publicClient ?? null,
        }),
      )
    },
    [buildSnapshot, runStep, walletAddress, walletChainId, walletClient, publicClient],
  )

  const step3 = useCallback(
    (
      override?: DemoState,
    ): Promise<{
      ok: boolean
      patch?: Partial<DemoState>
      formSync?: actions.ActionResult['formSync']
    }> => {
      const snap = override ?? buildSnapshot()
      return runStep(snap.credentialType, 2, 'Local verify failed', () =>
        actions.localVerify(snap, {
          publicClient: publicClient ?? null,
          walletAddress: walletAddress ?? null,
        }),
      )
    },
    [buildSnapshot, runStep, publicClient, walletAddress],
  )

  const step4 = useCallback(
    (
      override?: DemoState,
    ): Promise<{
      ok: boolean
      patch?: Partial<DemoState>
      formSync?: actions.ActionResult['formSync']
    }> => {
      const snap = override ?? buildSnapshot()
      return runStep(
        snap.credentialType,
        3,
        snap.serverMode ? 'Submit & settle failed' : 'Build receipt failed',
        () =>
          snap.serverMode
            ? actions.submitCredentialToServer(snap)
            : actions.buildReceiptLocal(snap),
      )
    },
    [buildSnapshot, runStep],
  )

  /** Clear ONLY the active credential type's pool — Hash's output stays
   *  put when you clear from the Permit2 tab. */
  const handleClear = useCallback((): void => {
    resetPool(credentialType)
  }, [credentialType, resetPool])

  // Run All threads a local snapshot through each step, merging the
  // previous step's patch BEFORE calling the next. Without this, each
  // step would build its snapshot from React state which hasn't
  // re-rendered yet (setState across `await` boundaries doesn't commit
  // synchronously in the same microtask), so step N+1 would see step
  // N-1's state. Concrete repro of the old bug: switch from Hash to
  // Permit2 tab → Run All. step2 sets credential to a fresh Permit2
  // credential, but step3's snapshot still has the OLD Hash credential
  // → `payload.permit` undefined → "Cannot read properties of undefined
  // (reading 'permitted')". Per-pool state also fixes this for tab
  // switches, but the snap-threading is still required for back-to-back
  // steps within a single run.
  const handleRunAll = useCallback(async (): Promise<void> => {
    handleClear()
    let snap = buildSnapshot()
    // After handleClear the active pool is reset; rebuild the snap so
    // the threaded value starts from a clean ExecState slice.
    snap = {
      ...snap,
      challenge: null,
      credential: null,
      settlementTxHash: null,
      recovered: null,
      receiptHeader: null,
    }
    const r1 = await step1(snap)
    if (!r1.ok) return
    snap = { ...snap, ...r1.patch }
    // Thread server-synced form fields (server mode step 1 = fetch 402).
    // Without this, step 2 builds the credential / broadcasts against the
    // STALE pre-fetch chain / recipient / amount / realm — React state
    // from applyFormSync hasn't committed across the awaited chain yet.
    if (r1.formSync) {
      const fs = r1.formSync
      snap = {
        ...snap,
        ...(fs.chainKey !== undefined && { chainKey: fs.chainKey }),
        ...(fs.recipient !== undefined && { recipient: fs.recipient }),
        ...(fs.realm !== undefined && { realm: fs.realm }),
        ...(fs.amountDecimal !== undefined && { amountDecimal: fs.amountDecimal }),
      }
    }
    const r2 = await step2(snap)
    if (!r2.ok) return
    snap = { ...snap, ...r2.patch }
    const r3 = await step3(snap)
    if (!r3.ok) return
    snap = { ...snap, ...r3.patch }
    await step4(snap)
  }, [handleClear, buildSnapshot, step1, step2, step3, step4])

  /* -------------------------------------------------------------------- */
  /*  Auto-fetch on page load (server mode) — fires once per page mount    */
  /*  for the credential type that was active at mount time.               */
  /* -------------------------------------------------------------------- */

  const autoFetchRanRef = useRef(false)
  useEffect(() => {
    if (autoFetchRanRef.current) return
    if (!serverMode) return
    autoFetchRanRef.current = true
    void (async () => {
      const typeAtMount = credentialType
      setStep(typeAtMount, 0, 'running')
      const snap = buildSnapshot()
      try {
        const result = await actions.fetchChallengeFromServer(snap)
        applyPatchToPool(typeAtMount, result.patch)
        applyFormSync(result.formSync)
        pushPanel(typeAtMount, result.panel)
        setStep(typeAtMount, 0, 'ok')
      } catch (err) {
        setStep(typeAtMount, 0, 'err')
        const msg = err instanceof Error ? err.message : String(err)
        const body = (
          <div className="space-y-1 text-xs text-amber-300">
            <div>
              Could not auto-fetch the initial 402 from{' '}
              <code className="font-mono">{serverEndpoint}</code>.
            </div>
            <div className="text-muted-foreground">{msg}</div>
            <div className="pt-1 text-muted-foreground">
              The form is showing the last-persisted (localStorage) values. Start the charge-server
              and click <strong className="text-primary">1 · Fetch challenge</strong> to re-sync.
            </div>
          </div>
        )
        pushPanel(typeAtMount, {
          id: -1,
          title: 'Auto-fetch on page load failed',
          status: 'warn',
          body,
        })
      }
    })()
    // Intentionally only run on mount when serverMode is true.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* -------------------------------------------------------------------- */
  /*  Persist chainKey on chain match.                                     */
  /* -------------------------------------------------------------------- */

  useEffect(() => {
    savePersisted(STORAGE_KEYS.chainKey, chainKey)
  }, [chainKey])

  /* -------------------------------------------------------------------- */
  /*  Render-derived bits                                                  */
  /* -------------------------------------------------------------------- */

  // Signer requirement is per credential type, not a coarse OR:
  //   - transaction: needs the in-page key (MetaMask can't expose a
  //     pre-signed-unbroadcast EIP-1559 RLP), connected wallet alone
  //     is NOT enough.
  //   - hash / permit2 / authorization: need a connected wallet (to
  //     broadcast the transfer / sign EIP-712); an in-page key alone
  //     is NOT enough.
  const haveSigner = credentialType === 'transaction' ? inPageAccount !== null : isConnected
  const stepLabels: [string, string, string, string] = [
    serverMode ? '1 · Fetch challenge' : '1 · Issue challenge',
    '2 · Build credential',
    '3 · Local verify',
    serverMode ? '4 · Submit & settle' : '4 · Build receipt',
  ]
  const buttonLabels: [string, string, string, string] = [
    serverMode ? 'Fetch challenge from server' : 'Issue challenge',
    'Build credential',
    'Local verify',
    serverMode ? 'Submit & settle on server' : 'Build receipt',
  ]
  const buttonDisabled: [boolean, boolean, boolean, boolean] = [
    false,
    !(active.challenge !== null && haveSigner),
    active.credential === null,
    active.credential === null,
  ]
  const showSplits = credentialType === 'permit2'
  const showInPageKey = credentialType === 'transaction'

  const chainMatchesWallet = useMemo(() => {
    if (!walletChainId) return null
    return CHAIN_PRESETS.find((p) => p.chainId === walletChainId)?.key === chainKey
  }, [walletChainId, chainKey])

  return (
    <div className="min-h-screen">
      <Header />
      <StatusBar />
      <main className="mx-auto max-w-6xl space-y-6 px-6 py-8">
        <CredentialTabsBar value={credentialType} onChange={handleTabChange} />
        <RealismCallout type={credentialType} />
        <ConfigPanel
          chainKey={chainKey}
          setChainKey={setChainKey}
          bindingMode={bindingMode}
          setBindingMode={setBindingMode}
          amountDecimal={amountDecimal}
          setAmountDecimal={setAmountDecimal}
          amountBase={amountBase}
          recipient={recipient}
          setRecipient={setRecipient}
          realm={realm}
          setRealm={setRealm}
          serverMode={serverMode}
          setServerMode={setServerMode}
          serverEndpoint={serverEndpoint}
          setServerEndpoint={setServerEndpoint}
        />
        <ServerConfigPanel serverEndpoint={serverEndpoint} enabled={serverMode} />
        {showSplits && (
          <>
            <Permit2AllowancePanel
              preset={getPresetByKey(chainKey)}
              amountBase={amountBase}
              {...(activePermit2Address && { permit2Address: activePermit2Address })}
            />
            <SplitsEditor
              splits={splits}
              setSplits={setSplitsWithReset}
              totalBaseUnits={amountBase}
            />
          </>
        )}
        {showInPageKey && <InPageKeyPanel account={inPageAccount} onGenerate={setInPageAccount} />}

        <div className="space-y-3">
          <StepBar
            stepStates={active.stepStates}
            stepLabels={stepLabels}
            runAllDisabled={!haveSigner}
            onRunAll={() => void handleRunAll()}
            onClear={handleClear}
          />
          <StepButtons
            labels={buttonLabels}
            disabled={buttonDisabled}
            onClick={[
              () => void step1(),
              () => void step2(),
              () => void step3(),
              () => void step4(),
            ]}
          />
        </div>

        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Output <span className="text-primary">· {credentialType}</span>
          </h2>
          <OutputPanel panels={active.panels} />
        </section>

        <FailureCases baseline={failureBaseline} />

        <footer className="space-y-1 border-t border-border pt-8 text-xs text-muted-foreground">
          <div>
            <span className="font-semibold text-foreground">@bnb-chain/mpp</span> ·{' '}
            <span>draft-evm-charge-00 on mppx@0.6.28</span>
            {chainMatchesWallet === false && (
              <span className="ml-2 text-amber-400">
                (wallet chain doesn't match selected preset)
              </span>
            )}
          </div>
          <div>
            On-chain settlement happens only when the wallet is on{' '}
            <span className="font-mono">Sepolia</span>; mainnet entries are wire-shape-only inspect
            targets. Server-side verifier lives in{' '}
            <span className="font-mono">examples/charge-server</span>; testnet e2e scaffolds in{' '}
            <span className="font-mono">test/live/*</span>.
          </div>
        </footer>
      </main>
    </div>
  )
}
