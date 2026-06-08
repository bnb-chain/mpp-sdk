/**
 * Step 4a: build receipt locally (local mode).
 *
 * Synthesizes an EVM receipt for the issued challenge (using the real
 * settlement txHash as `reference` when one exists, else a deterministic
 * placeholder), then proves the C2 codec round-trips
 * (serialize → deserialize → deep-equal).
 */

import { buildEvmReceipt, deserializeEvmReceipt, serializeEvmReceipt } from '@bnb-chain/mpp'
import { type Hex, keccak256 } from 'viem'

import { JsonBlock } from '@/components/JsonBlock'
import { explorerTxUrl, getPresetByKey } from '@/protocol/presets.js'
import { type DemoState } from '@/state/types'

import { type ActionResult, panel } from './shared'

export function buildReceiptLocal(state: DemoState): ActionResult {
  const challenge = state.challenge
  const credential = state.credential
  if (!challenge) throw new Error('Issue a challenge first.')
  if (!credential) throw new Error('Build a credential first.')

  const preset = getPresetByKey(state.chainKey)
  const reference: Hex =
    state.settlementTxHash ??
    (keccak256(new TextEncoder().encode(`demo-not-settled-${challenge.id}`)) as Hex)

  const receipt = buildEvmReceipt({
    method: 'evm',
    status: 'success',
    challengeId: challenge.id,
    reference,
    timestamp: new Date().toISOString(),
    chainId: preset.chainId,
    externalId: 'demo-external-id',
  })
  const receiptHeader = serializeEvmReceipt(receipt)
  const decoded = deserializeEvmReceipt(receiptHeader)
  const matches = JSON.stringify(receipt) === JSON.stringify(decoded)
  const explorerLink = state.settlementTxHash
    ? explorerTxUrl(preset.chainId, state.settlementTxHash)
    : null

  const body = (
    <div className="space-y-3">
      {!state.settlementTxHash ? (
        <div className="text-xs text-amber-300">
          ⚠ This credential type doesn't broadcast on-chain in the demo (server-side concern).{' '}
          <code className="font-mono">reference</code> here is a placeholder; in production the
          verifier's settlement tx hash goes here.
        </div>
      ) : (
        <div className="text-xs text-emerald-300">
          ✓ <code className="font-mono">reference</code> is the real BSC Testnet settlement tx hash
          from the hash credential's broadcast.
        </div>
      )}
      {explorerLink && (
        <div className="text-xs">
          <a
            href={explorerLink}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            View settlement tx on explorer ↗
          </a>
        </div>
      )}
      <details className="rounded-md border border-border bg-background/50">
        <summary className="cursor-pointer px-4 py-2 font-mono text-xs text-muted-foreground hover:text-foreground">
          ▶ Payment-Receipt header value (base64url JSON)
        </summary>
        <pre className="break-all whitespace-pre-wrap px-4 pb-3 font-mono text-xs text-emerald-300">
          {receiptHeader}
        </pre>
      </details>
      <div className="text-xs text-muted-foreground">Decoded:</div>
      <JsonBlock value={decoded} />
      <div className="text-sm">
        Round-trip identical:{' '}
        <span className={matches ? 'font-mono text-emerald-400' : 'font-mono text-red-400'}>
          {String(matches)}
        </span>
      </div>
    </div>
  )

  return {
    patch: { receiptHeader },
    panel: panel('Receipt — C2 codec round-trip', body),
  }
}
