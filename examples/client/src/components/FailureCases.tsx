/**
 * "Failure cases / Security checks" — a panel that demonstrates the SDK's
 * REJECTIONS, not its happy path. Each live case constructs an attack /
 * mistake and shows the guard firing. All live cases run entirely
 * client-side with zero gas: they exercise the mppx HMAC challenge binding,
 * the client credential-constructor asserts, and the expiry assertion.
 *
 * Two cases (replay, missing Permit2 approval) only reject at on-chain
 * settlement, so they need a funded testnet — those are shown as
 * explanatory cards rather than faked client-side.
 *
 * "Rejected as expected" (green) is the SUCCESS state here: it means the
 * guard caught the bad input. A red result would mean a guard FAILED to
 * fire — a real bug.
 */

import { createHashCredential } from '@bnb-chain/mpp/client'
import { Lock, Play, ShieldAlert, ShieldCheck, Zap } from 'lucide-react'
import { Challenge, Expires } from 'mppx'
import * as React from 'react'
import { type Address } from 'viem'

import { DEMO_PERMIT2_SPENDER, DEMO_SECRET } from '@/actions/shared'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { type ChainPreset, PERMIT2_ADDRESS } from '@/protocol/presets.js'

/** Baseline (valid) inputs the cases mutate to construct each failure. */
export interface FailureBaseline {
  readonly preset: ChainPreset
  readonly recipient: Address
  /** Total amount in base units (e.g. "1000000000000000000" for 1 USDT @ 18 dec). */
  readonly amountBaseUnits: string
  readonly realm: string
}

interface FailureResult {
  /** true = the guard rejected the bad input (the GOOD outcome here). */
  readonly rejected: boolean
  readonly detail: string
}

interface LiveCase {
  readonly id: string
  readonly title: string
  readonly guard: string
  readonly run: (b: FailureBaseline) => FailureResult | Promise<FailureResult>
}

// A distinct, valid throwaway address used as a tampered recipient / currency
// and as the split recipient. All-lowercase so it passes a strict checksum.
const OTHER_ADDR = '0x000000000000000000000000000000000000beef' as const
// Well-formed bytes32 — never actually read (the type/splits asserts throw
// before the hash is validated).
const DUMMY_HASH = `0x${'11'.repeat(32)}` as const

type MethodDetails = {
  chainId: number
  permit2Address: string
  permit2Spender: string
  credentialTypes: string[]
  decimals: number
  splits?: Array<{ recipient: string; amount: string }>
}
type ChargeRequest = {
  amount: string
  currency: string
  recipient: string
  methodDetails: MethodDetails
}

function baseRequest(
  b: FailureBaseline,
  opts?: { credentialTypes?: string[]; splits?: Array<{ recipient: string; amount: string }> },
): ChargeRequest {
  return {
    amount: b.amountBaseUnits,
    currency: b.preset.currency,
    recipient: b.recipient,
    methodDetails: {
      chainId: b.preset.chainId,
      permit2Address: PERMIT2_ADDRESS,
      permit2Spender: DEMO_PERMIT2_SPENDER,
      credentialTypes: opts?.credentialTypes ?? ['authorization', 'permit2', 'transaction', 'hash'],
      decimals: b.preset.decimals,
      ...(opts?.splits && { splits: opts.splits }),
    },
  }
}

function issue(
  b: FailureBaseline,
  expires: string,
  opts?: { credentialTypes?: string[]; splits?: Array<{ recipient: string; amount: string }> },
): Challenge.Challenge {
  return Challenge.from({
    method: 'evm',
    intent: 'charge',
    realm: b.realm,
    request: baseRequest(b, opts),
    expires,
    secretKey: DEMO_SECRET,
  }) as Challenge.Challenge
}

/** Issue a valid signed challenge, tamper one field on a copy (keeping the
 *  original HMAC-bound id), and verify — expect `false` (binding caught it). */
function tamperCase(b: FailureBaseline, mutate: (req: ChargeRequest) => void): FailureResult {
  const challenge = issue(b, Expires.minutes(10))
  const tamperedReq = structuredClone(challenge.request) as ChargeRequest
  mutate(tamperedReq)
  const tampered = { ...challenge, request: tamperedReq } as Challenge.Challenge
  const stillValid = Challenge.verify(tampered, { secretKey: DEMO_SECRET })
  return stillValid
    ? { rejected: false, detail: 'UNEXPECTED: Challenge.verify accepted a tampered challenge.' }
    : {
        rejected: true,
        detail:
          'Challenge.verify(tampered) === false — the HMAC-bound challenge id caught the change.',
      }
}

/** Run `fn` expecting it to throw; rejected=true means the guard fired. */
async function expectThrow(fn: () => unknown | Promise<unknown>): Promise<FailureResult> {
  try {
    await fn()
    return { rejected: false, detail: 'UNEXPECTED: the SDK did not reject — this would be a bug.' }
  } catch (e) {
    return { rejected: true, detail: e instanceof Error ? e.message : String(e) }
  }
}

const LIVE_CASES: readonly LiveCase[] = [
  {
    id: 'tamper-amount',
    title: 'Tamper amount',
    guard: 'mppx HMAC challenge binding',
    run: (b) =>
      tamperCase(b, (r) => {
        r.amount = (BigInt(r.amount) + 1n).toString()
      }),
  },
  {
    id: 'tamper-recipient',
    title: 'Tamper recipient',
    guard: 'mppx HMAC challenge binding',
    run: (b) =>
      tamperCase(b, (r) => {
        r.recipient = OTHER_ADDR
      }),
  },
  {
    id: 'tamper-currency',
    title: 'Tamper currency (swap token)',
    guard: 'mppx HMAC challenge binding',
    run: (b) =>
      tamperCase(b, (r) => {
        r.currency = OTHER_ADDR
      }),
  },
  {
    id: 'wrong-chain',
    title: 'Tamper chainId (wrong chain)',
    guard: 'mppx HMAC challenge binding',
    run: (b) =>
      tamperCase(b, (r) => {
        r.methodDetails.chainId = r.methodDetails.chainId === 1 ? 11155111 : 1
      }),
  },
  {
    id: 'wrong-type',
    title: 'Wrong credential type',
    guard: 'client assertCredentialTypeAccepted',
    // Challenge advertises only ['permit2']; building a hash credential must
    // be rejected before any work.
    run: (b) =>
      expectThrow(() =>
        createHashCredential({
          challenge: issue(b, Expires.minutes(10), { credentialTypes: ['permit2'] }),
          hash: DUMMY_HASH,
        }),
      ),
  },
  {
    id: 'splits-misuse',
    title: 'Splits on a non-permit2 type',
    guard: 'client assertNoSplitsForNonPermit2',
    // Challenge has splits + accepts hash; only permit2 can fulfill splits.
    run: (b) =>
      expectThrow(() =>
        createHashCredential({
          challenge: issue(b, Expires.minutes(10), {
            credentialTypes: ['hash'],
            splits: [{ recipient: OTHER_ADDR, amount: '1' }],
          }),
          hash: DUMMY_HASH,
        }),
      ),
  },
  {
    id: 'expired',
    title: 'Expired challenge',
    guard: 'mppx Expires.assert',
    // A correctly-signed challenge whose expiry is in the past. The HMAC is
    // valid, so the expiry assertion (run by the server binding) is what
    // rejects it.
    run: (b) => expectThrow(() => Expires.assert(issue(b, Expires.seconds(-60)).expires)),
  },
]

interface DeferredCase {
  readonly title: string
  readonly guard: string
  readonly note: string
}

const DEFERRED_CASES: readonly DeferredCase[] = [
  {
    title: 'Replay the same credential',
    guard: 'durable replay store (3-state CAS)',
    note: 'Submitting an accepted credential twice: the second hits the replay store and returns REJECTED (the slot is consumed). This only manifests at settlement against a real server + funded signer, so it is not run here.',
  },
  {
    title: 'Missing Permit2 approval',
    guard: 'server-side settlement simulation',
    note: 'If ERC20.allowance(signer, Permit2) is 0, permitWitnessTransferFrom reverts. The server catches this in pre-broadcast simulation. Needs a funded testnet to demonstrate — see the Permit2 allowance panel on the Permit2 tab.',
  },
]

function ResultLine({ result }: { result: FailureResult | 'running' }): JSX.Element {
  if (result === 'running') {
    return <div className="text-xs text-muted-foreground">running…</div>
  }
  if (result.rejected) {
    return (
      <div className="flex items-start gap-2 text-xs">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
        <div>
          <span className="font-semibold text-emerald-300">Rejected as expected.</span>{' '}
          <span className="break-words font-mono text-[11px] text-muted-foreground">
            {result.detail}
          </span>
        </div>
      </div>
    )
  }
  return (
    <div className="flex items-start gap-2 text-xs">
      <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
      <div>
        <span className="font-semibold text-red-300">NOT rejected — unexpected.</span>{' '}
        <span className="break-words font-mono text-[11px] text-muted-foreground">
          {result.detail}
        </span>
      </div>
    </div>
  )
}

export function FailureCases({ baseline }: { baseline: FailureBaseline | null }): JSX.Element {
  const [results, setResults] = React.useState<Record<string, FailureResult | 'running'>>({})

  const runCase = React.useCallback(
    async (c: LiveCase): Promise<void> => {
      if (!baseline) return
      setResults((r) => ({ ...r, [c.id]: 'running' }))
      try {
        const res = await Promise.resolve(c.run(baseline))
        setResults((r) => ({ ...r, [c.id]: res }))
      } catch (e) {
        // A throw HERE means the case helper itself errored (not the guard
        // under test) — surface it as a non-rejection so it's visible.
        setResults((r) => ({
          ...r,
          [c.id]: {
            rejected: false,
            detail: `case harness error: ${e instanceof Error ? e.message : String(e)}`,
          },
        }))
      }
    },
    [baseline],
  )

  const runAll = React.useCallback(async (): Promise<void> => {
    for (const c of LIVE_CASES) await runCase(c)
  }, [runCase])

  return (
    <details className="group rounded-lg border border-border bg-card/40">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-semibold">
        <ShieldCheck className="h-4 w-4 text-emerald-400" />
        Failure cases / Security checks
        <span className="font-normal text-muted-foreground">— the guards the SDK enforces</span>
        <span className="ml-auto text-xs text-muted-foreground group-open:hidden">show</span>
        <span className="ml-auto hidden text-xs text-muted-foreground group-open:inline">hide</span>
      </summary>

      <div className="space-y-3 border-t border-border px-4 py-4">
        <div className="flex items-center gap-2">
          <Button onClick={() => void runAll()} disabled={!baseline} className="gap-1.5">
            <Zap className="h-4 w-4" />
            Run all checks
          </Button>
          {!baseline && (
            <span className="text-xs text-amber-300">
              Waiting for a valid recipient + amount from the server's 402 — start examples/server
              and fetch a challenge, then these run.
            </span>
          )}
        </div>

        {LIVE_CASES.map((c) => (
          <Card key={c.id}>
            <CardContent className="space-y-2 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{c.title}</span>
                <span className="font-mono text-[10px] text-muted-foreground">{c.guard}</span>
                <Button
                  size="sm"
                  variant="secondary"
                  className="ml-auto gap-1.5"
                  disabled={!baseline || results[c.id] === 'running'}
                  onClick={() => void runCase(c)}
                >
                  <Play className="h-3 w-3" />
                  Run
                </Button>
              </div>
              {results[c.id] && <ResultLine result={results[c.id]!} />}
            </CardContent>
          </Card>
        ))}

        <div className="pt-1 text-xs font-semibold text-muted-foreground">
          Settlement-time guards (need a funded testnet — explained, not run)
        </div>
        {DEFERRED_CASES.map((d) => (
          <Card key={d.title} className="border-amber-700/40 bg-amber-950/20">
            <CardContent className="space-y-1 p-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Lock className="h-3.5 w-3.5 text-amber-400" />
                {d.title}
                <span className="font-mono text-[10px] text-muted-foreground">{d.guard}</span>
              </div>
              <p className="text-xs text-muted-foreground">{d.note}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </details>
  )
}
