/**
 * Step 1a: fetch challenge from server (server mode).
 *
 * Issues a bare GET against the configured endpoint, expects an HTTP 402
 * with a WWW-Authenticate header, deserializes it into a Challenge, and
 * syncs the demo form fields to the server's request.
 */

import { Challenge } from 'mppx'
import { type Address } from 'viem'

import { JsonBlock } from '@/components/JsonBlock'
import { CHAIN_PRESETS, STORAGE_KEYS, savePersisted } from '@/protocol/presets.js'
import { type DemoState } from '@/state/types'

import { type ActionResult, panel } from './shared'

export async function fetchChallengeFromServer(state: DemoState): Promise<ActionResult> {
  const resp = await fetch(state.serverEndpoint, { method: 'GET' })
  if (resp.status !== 402) {
    throw new Error(
      `Expected HTTP 402 from ${state.serverEndpoint}, got ${resp.status} ${resp.statusText}. ` +
        `(Is the charge-server running? Vite proxies /api → http://localhost:3000.)`,
    )
  }
  const wwwAuth = resp.headers.get('WWW-Authenticate')
  if (!wwwAuth) {
    throw new Error(
      'Server returned 402 but no WWW-Authenticate header — cannot deserialize a challenge.',
    )
  }
  let challenge: Challenge.Challenge
  try {
    challenge = Challenge.deserialize(wwwAuth)
  } catch (cause) {
    throw new Error(`Challenge.deserialize rejected the server's WWW-Authenticate header.`, {
      cause,
    })
  }

  const req = challenge.request as {
    amount: string
    currency: Address
    recipient: Address
    methodDetails: { chainId: number; decimals: number }
  }
  // Match on EXACT (chainId, currency). A same-chain DIFFERENT token has its
  // own decimals + EIP-712 domain, so a chainId-only fallback would mis-parse
  // the amount (e.g. read 18-dec PYUSD as 6-dec USDC) and pick the wrong
  // signing domain. With no exact match, trust the challenge's own
  // methodDetails.decimals and DON'T sync the chain selector — the local
  // preset's signing inputs wouldn't match this token.
  const exactPreset = CHAIN_PRESETS.find(
    (p) =>
      p.chainId === req.methodDetails.chainId &&
      p.currency.toLowerCase() === req.currency.toLowerCase(),
  )
  const decimals = exactPreset?.decimals ?? req.methodDetails.decimals
  const bigAmount = BigInt(req.amount)
  const divisor = 10n ** BigInt(decimals)
  const whole = bigAmount / divisor
  const frac = bigAmount % divisor
  const amountDecimal =
    frac === 0n
      ? whole.toString()
      : `${whole}.${frac.toString().padStart(decimals, '0').replace(/0+$/, '')}`

  const formSync: ActionResult['formSync'] = {
    recipient: req.recipient,
    realm: challenge.realm,
    amountDecimal,
  }
  if (exactPreset) {
    formSync.chainKey = exactPreset.key
    savePersisted(STORAGE_KEYS.chainKey, exactPreset.key)
  }
  savePersisted(STORAGE_KEYS.recipient, req.recipient)
  savePersisted(STORAGE_KEYS.realm, challenge.realm)
  savePersisted(STORAGE_KEYS.amount, amountDecimal)

  const body = (
    <div className="space-y-3">
      <div className="text-xs text-emerald-300">
        ✓ Server's WWW-Authenticate parsed via{' '}
        <code className="font-mono">Challenge.deserialize</code>.
      </div>
      {exactPreset ? (
        <div className="text-xs text-muted-foreground">
          Form fields synced to server (chain / recipient / realm / amount).
        </div>
      ) : (
        <div className="text-xs text-amber-300">
          Token <code className="font-mono">{req.currency}</code> isn't a demo chain preset — synced
          recipient / realm / amount (decimals {decimals} from the challenge), but left the chain
          selector unchanged. Client-side signing uses your selected preset and may not match this
          token.
        </div>
      )}
      <JsonBlock
        value={{
          id: challenge.id,
          method: challenge.method,
          intent: challenge.intent,
          realm: challenge.realm,
          request: challenge.request,
          expires: challenge.expires,
        }}
      />
    </div>
  )

  return {
    patch: { challenge },
    panel: panel(`Server-issued challenge (HTTP 402 from ${state.serverEndpoint})`, body),
    formSync,
  }
}
