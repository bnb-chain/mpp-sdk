import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type Address, isAddress } from 'viem'
import { useAccount, useChainId, usePublicClient, useWalletClient } from 'wagmi'

import * as actions from '@/actions'
import { ConfigPanel } from '@/components/ConfigPanel'
import { CredentialTabsBar } from '@/components/CredentialTabsBar'
import { FailureCases, type FailureBaseline } from '@/components/FailureCases'
import { Header } from '@/components/Header'
import { OutputPanel } from '@/components/OutputPanel'
import { Permit2AllowancePanel } from '@/components/Permit2AllowancePanel'
import { RealismCallout } from '@/components/RealismCallout'
import { ServerConfigPanel } from '@/components/ServerConfigPanel'
import { SplitsEditor } from '@/components/SplitsEditor'
import { StatusBar } from '@/components/StatusBar'
import { StepBar, StepButtons } from '@/components/StepBar'
import { usePersistedString } from '@/hooks/usePersistedState'
import {
  CHAIN_PRESETS,
  CREDENTIAL_META,
  STORAGE_KEYS,
  type CredentialType,
  getPresetByKey,
  savePersisted,
  visibleCredentialTypes,
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
// Overridable so this build can point at a different server-mode deployment
// (e.g. examples/server running b402 mode 3 on mainnet $U instead of the
// zero-config testnet TEST_USDT mode) without a code change — set
// VITE_DEFAULT_CHAIN_KEY / VITE_DEFAULT_ENDPOINT alongside
// VITE_CHARGE_SERVER_URL (vite.config.ts) in examples/client/.env.
// The env chainKey is validated against CHAIN_PRESETS at module scope: a
// typo'd value must fall back to a known preset, not crash the first render
// (getPresetByKey throws on unknown keys, and the persisted-key coercion
// below terminates at DEFAULT_CHAIN_KEY).
const envChainKey = import.meta.env.VITE_DEFAULT_CHAIN_KEY as string | undefined
const DEFAULT_CHAIN_KEY =
  envChainKey && CHAIN_PRESETS.some((p) => p.key === envChainKey) ? envChainKey : 'bsc-testnet'
const DEFAULT_CREDENTIAL_TYPE: CredentialType = 'hash'
const DEFAULT_ENDPOINT = import.meta.env.VITE_DEFAULT_ENDPOINT ?? '/api/premium'

type Pools = Record<CredentialType, ExecState>

/** Build a fresh set of independent pools, each with its own arrays. */
function freshPools(): Pools {
  return {
    hash: freshExecState(),
    permit2: freshExecState(),
    authorization: freshExecState(),
    x402: freshExecState(),
  }
}

export function App(): JSX.Element {
  // ── Persisted form state (shared across all credential types) ────────
  const [credentialTypeRaw, setCredentialType] = usePersistedString<CredentialType>(
    STORAGE_KEYS.credentialType,
    DEFAULT_CREDENTIAL_TYPE,
  )
  // Clamp the raw persisted value SYNCHRONOUSLY (same reasoning as chainKey
  // below): older builds persisted since-removed types (e.g. 'transaction')
  // under the same storage key, and `pools[credentialType]` is indexed during
  // render — an effect-based fix would run after the undefined dereference
  // already crashed the first render.
  const credentialType: CredentialType =
    credentialTypeRaw in CREDENTIAL_META ? credentialTypeRaw : DEFAULT_CREDENTIAL_TYPE
  const [chainKeyRaw, setChainKeyRaw] = usePersistedString<string>(
    STORAGE_KEYS.chainKey,
    DEFAULT_CHAIN_KEY,
  )
  // A chainKey persisted by an earlier build (e.g. 'sepolia') may no longer
  // exist in CHAIN_PRESETS. Coerce unknown keys to the default
  // SYNCHRONOUSLY — getPresetByKey throws on unknown keys and runs during
  // render (the amountBase memo below), so an effect-based fix is too late.
  // The savePersisted effect further down then rewrites the corrected value.
  const chainKey = CHAIN_PRESETS.some((p) => p.key === chainKeyRaw)
    ? chainKeyRaw
    : DEFAULT_CHAIN_KEY
  const [amountDecimal, setAmountDecimalRaw] = usePersistedString<string>(
    STORAGE_KEYS.amount,
    DEFAULT_AMOUNT,
  )
  const [recipient, setRecipientRaw] = usePersistedString<string>(
    STORAGE_KEYS.recipient,
    DEFAULT_RECIPIENT,
  )
  const [realm, setRealmRaw] = usePersistedString<string>(STORAGE_KEYS.realm, DEFAULT_REALM)
  // The demo always runs end-to-end: step 1 fetches a live 402, step 4
  // submits the credential back for settlement. The endpoint follows the
  // .env default and is NOT persisted — persisting would let a STALE
  // localStorage value from an earlier visit silently override a changed
  // VITE_DEFAULT_ENDPOINT, exactly the trap that once made the b402
  // pairing appear broken.
  const serverEndpoint = DEFAULT_ENDPOINT

  // ── Non-persisted shared state ───────────────────────────────────────
  const [splits, setSplits] = useState<DemoState['splits']>([])

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

  /** Reset ALL pools — used when a form field that's bound into the
   *  challenge (chain / recipient / realm / amount) changes. Any in-flight
   *  challenge for ANY type would be stale against the new field value. */
  const resetAllPools = useCallback((): void => {
    setPools(freshPools())
  }, [])

  /** Reset a single pool — used when something type-specific changes
   *  (e.g. splits, which only ride on Permit2). */
  const resetPool = useCallback((type: CredentialType): void => {
    setPools((prev) => ({ ...prev, [type]: freshExecState() }))
  }, [])

  // The chain preset is the one user-editable field; switching it clears
  // every pool — any in-flight challenge/offer was fetched for the OLD
  // preset and would be misleading against the new one. (Amount / recipient
  // / realm are server-managed read-only mirrors, synced via applyFormSync.)
  const setChainKey = useCallback(
    (v: string) => {
      setChainKeyRaw(v)
      resetAllPools()
    },
    [setChainKeyRaw, resetAllPools],
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

  // Which credential tabs the ACTIVE chain preset surfaces (eip3009 tokens →
  // `authorization`; plain BEP-20s → `hash` + `permit2`). Recomputed when the
  // chain changes — e.g. a server 402 for `bsc`/U syncs the selector to the
  // `bsc` preset, flipping the tab bar to the authorization-only path.
  const visibleTypes = useMemo(() => visibleCredentialTypes(getPresetByKey(chainKey)), [chainKey])

  // Keep the active tab valid for the selected chain. If the current type
  // isn't surfaced by this preset (e.g. `hash` while on `bsc`/U), coerce to
  // the preset's first visible tab so the active tab always has a trigger.
  useEffect(() => {
    if (!visibleTypes.includes(credentialType)) {
      setCredentialType(visibleTypes[0])
    }
  }, [visibleTypes, credentialType, setCredentialType])

  // Tab switch only changes which pool is active — it does NOT touch
  // `splits`. Splits are Permit2-only and the server sources them from the
  // 402, not local state, so they persist with the Permit2 pool and stay
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
      amountDecimal,
      recipient: recipient as Address,
      realm,
      splits,
      serverEndpoint,
      challenge: active.challenge,
      x402Offer: active.x402Offer,
      credential: active.credential,
      settlementTxHash: active.settlementTxHash,
      recovered: active.recovered,
      receiptHeader: active.receiptHeader,
    }),
    [credentialType, chainKey, amountDecimal, recipient, realm, splits, serverEndpoint, active],
  )

  /* -------------------------------------------------------------------- */
  /*  Patch / step-state writers — all target the active pool              */
  /* -------------------------------------------------------------------- */

  const applyPatchToPool = useCallback((type: CredentialType, patch: Partial<DemoState>): void => {
    setPools((prev) => {
      const cur = prev[type]
      const next: ExecState = { ...cur }
      if (patch.challenge !== undefined) next.challenge = patch.challenge
      if (patch.x402Offer !== undefined) next.x402Offer = patch.x402Offer
      if (patch.credential !== undefined) next.credential = patch.credential
      if (patch.settlementTxHash !== undefined) next.settlementTxHash = patch.settlementTxHash
      if (patch.recovered !== undefined) next.recovered = patch.recovered
      if (patch.receiptHeader !== undefined) next.receiptHeader = patch.receiptHeader
      return { ...prev, [type]: next }
    })
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
        // Route the result into the pool that stays VISIBLE after any
        // formSync preset flip. fetchChallengeFromServer re-syncs chainKey to
        // the server's (chainId, currency) preset; if that flip hides the
        // current tab (e.g. user on a $U preset fetching from a USDT-serving
        // server → tab set becomes hash/permit2/x402), storing under `type`
        // would bury the challenge — and this catch's panels — in a pool no
        // visible tab renders, making step 1 look like a silent no-op.
        const syncedChain = result.formSync?.chainKey
        let target = type
        if (syncedChain) {
          const visibleAfterSync = visibleCredentialTypes(getPresetByKey(syncedChain))
          if (!visibleAfterSync.includes(type)) target = visibleAfterSync[0]
        }
        applyPatchToPool(target, result.patch)
        applyFormSync(result.formSync)
        pushPanel(target, result.panel)
        setStep(target, idx, 'ok')
        if (target !== type) setStep(type, idx, 'idle')
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
      // The x402 tab speaks the standalone x402 wire (JSON 402 body from
      // /x402/premium), not the mppx charge wire — its own step-1 action.
      if (snap.credentialType === 'x402') {
        return runStep(snap.credentialType, 0, 'Fetch x402 offer failed', () =>
          actions.fetchX402Offer(snap),
        )
      }
      return runStep(snap.credentialType, 0, 'Fetch challenge failed', () =>
        actions.fetchChallengeFromServer(snap),
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
      const ctx = {
        walletAddress: walletAddress ?? null,
        walletChainId: walletChainId ?? null,
        walletClient: walletClient ?? null,
        publicClient: publicClient ?? null,
      }
      if (snap.credentialType === 'x402') {
        return runStep(snap.credentialType, 1, 'Approve + sign failed', () =>
          actions.buildX402Payment(snap, ctx),
        )
      }
      return runStep(snap.credentialType, 1, 'Build credential failed', () =>
        actions.buildCredential(snap, ctx),
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
      if (snap.credentialType === 'x402') {
        return runStep(snap.credentialType, 2, 'Local verify failed', () =>
          actions.verifyX402Local(snap),
        )
      }
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
      if (snap.credentialType === 'x402') {
        return runStep(snap.credentialType, 3, 'x402 payment failed', () =>
          actions.submitX402Payment(snap),
        )
      }
      return runStep(snap.credentialType, 3, 'Submit & settle failed', () =>
        actions.submitCredentialToServer(snap),
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
      // If the preset re-sync hid the tab this run started on, stop here:
      // step 1's result was routed into the newly-active tab (runStep), and
      // steps 2-4 would sign against a preset the challenge doesn't match
      // (e.g. an authorization credential on a TEST_USDT challenge). The
      // user continues from the auto-activated tab.
      if (
        fs.chainKey !== undefined &&
        !visibleCredentialTypes(getPresetByKey(fs.chainKey)).includes(snap.credentialType)
      ) {
        return
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
    autoFetchRanRef.current = true
    void (async () => {
      // Coerce to a VISIBLE tab before fetching. The tab-coercion effect above
      // only schedules a re-render — it can't change what this first-render
      // closure captured — so a stale persisted type (e.g. 'hash' while a $U
      // preset only surfaces authorization/x402) would otherwise route the
      // fetched 402 (or this catch's guidance panel) into a pool no visible
      // tab renders, silently swallowing the auto-fetch.
      const visibleAtMount = visibleCredentialTypes(getPresetByKey(chainKey))
      const typeAtMount = visibleAtMount.includes(credentialType)
        ? credentialType
        : visibleAtMount[0]
      const isX402AtMount = typeAtMount === 'x402'
      setStep(typeAtMount, 0, 'running')
      const snap = { ...buildSnapshot(), credentialType: typeAtMount }
      try {
        const result = isX402AtMount
          ? await actions.fetchX402Offer(snap)
          : await actions.fetchChallengeFromServer(snap)
        // Same post-sync routing as runStep: if the server's 402 re-syncs the
        // preset and that hides typeAtMount, store under the tab that stays
        // visible — otherwise the auto-fetched challenge is silently buried.
        const syncedChain = result.formSync?.chainKey
        let target = typeAtMount
        if (syncedChain) {
          const visibleAfterSync = visibleCredentialTypes(getPresetByKey(syncedChain))
          if (!visibleAfterSync.includes(typeAtMount)) target = visibleAfterSync[0]
        }
        applyPatchToPool(target, result.patch)
        applyFormSync(result.formSync)
        pushPanel(target, result.panel)
        setStep(target, 0, 'ok')
        if (target !== typeAtMount) setStep(typeAtMount, 0, 'idle')
      } catch (err) {
        setStep(typeAtMount, 0, 'err')
        const msg = err instanceof Error ? err.message : String(err)
        const body = (
          <div className="space-y-1 text-xs text-amber-300">
            <div>
              Could not auto-fetch the initial 402 from{' '}
              <code className="font-mono">
                {isX402AtMount ? actions.X402_ENDPOINT : serverEndpoint}
              </code>
              .
            </div>
            <div className="text-muted-foreground">{msg}</div>
            <div className="pt-1 text-muted-foreground">
              The form is showing the last-persisted (localStorage) values. Start examples/server
              and click{' '}
              <strong className="text-primary">
                {isX402AtMount ? '1 · Fetch 402 offer' : '1 · Fetch challenge'}
              </strong>{' '}
              to re-sync.
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
    // Intentionally only run once on mount.
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

  // Every surfaced tab needs a connected wallet (broadcast the transfer /
  // sign EIP-712).
  const haveSigner = isConnected
  const isX402 = credentialType === 'x402'
  const stepLabels: [string, string, string, string] = isX402
    ? ['1 · Fetch 402 offer', '2 · Approve + sign', '3 · Local verify', '4 · Pay (X-PAYMENT)']
    : ['1 · Fetch challenge', '2 · Build credential', '3 · Local verify', '4 · Submit & settle']
  const buttonLabels: [string, string, string, string] = isX402
    ? [
        'Fetch 402 offer (x402 JSON)',
        'Approve (if needed) + sign permit',
        'Local verify',
        'Pay with X-PAYMENT header',
      ]
    : [
        'Fetch challenge from server',
        'Build credential',
        'Local verify',
        'Submit & settle on server',
      ]
  // Step 2 needs step 1's output — an mppx challenge for the charge-wire
  // tabs, the picked accepts[] offer for the x402 tab.
  const hasStep1Output = isX402 ? active.x402Offer !== null : active.challenge !== null
  const buttonDisabled: [boolean, boolean, boolean, boolean] = [
    false,
    !(hasStep1Output && haveSigner),
    active.credential === null,
    active.credential === null,
  ]
  const showSplits = credentialType === 'permit2'

  const chainMatchesWallet = useMemo(() => {
    if (!walletChainId) return null
    return CHAIN_PRESETS.find((p) => p.chainId === walletChainId)?.key === chainKey
  }, [walletChainId, chainKey])

  return (
    <div className="min-h-screen">
      <Header />
      <StatusBar />
      <main className="mx-auto max-w-6xl space-y-6 px-6 py-8">
        <CredentialTabsBar value={credentialType} types={visibleTypes} onChange={handleTabChange} />
        <RealismCallout type={credentialType} />
        <ConfigPanel
          chainKey={chainKey}
          setChainKey={setChainKey}
          amountDecimal={amountDecimal}
          amountBase={amountBase}
          recipient={recipient}
          realm={realm}
          serverEndpoint={serverEndpoint}
        />
        {/* The /api/config descriptor panel is mppx-wire-only; the x402 tab's
            step-1 output panel already shows everything the 402 JSON carries. */}
        {!isX402 && <ServerConfigPanel serverEndpoint={serverEndpoint} enabled />}
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
            On-chain settlement happens when the wallet is on{' '}
            <span className="font-mono">BSC Testnet</span> (chainId 97) holding test{' '}
            <span className="font-mono">USDT</span> + tBNB for gas — the{' '}
            <span className="font-mono">hash</span> and <span className="font-mono">permit2</span>{' '}
            paths. Selecting a <span className="font-mono">$U</span> preset switches to the{' '}
            <span className="font-mono">authorization</span> (EIP-3009) path: the wallet only{' '}
            <em>signs</em>; a b402-settling server (
            <span className="font-mono">examples/server</span> mode 3) broadcasts. The{' '}
            <span className="font-mono">x402 · Permit2</span> tab pays the same server's{' '}
            <span className="font-mono">/x402/premium</span> route over the standalone x402 wire
            (b402 permit2-exact). Testnet e2e scaffolds live in{' '}
            <span className="font-mono">test/live/*</span>.
          </div>
        </footer>
      </main>
    </div>
  )
}
