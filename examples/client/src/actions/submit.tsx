/**
 * Step 4: submit the credential to the server.
 *
 * Re-issues the GET with the credential in the Authorization header,
 * expects HTTP 200 + a Payment-Receipt header, deserializes it, and
 * asserts the receipt's challengeId / chainId / status line up with the
 * original challenge — the end-to-end roundtrip proof.
 */

import { deserializeEvmReceipt } from '@bnb-chain/mpp'

import { JsonBlock } from '@/components/JsonBlock'
import { explorerTxUrl } from '@/protocol/presets.js'
import { type DemoState } from '@/state/types'

import { type ActionResult, panel } from './shared'

export async function submitCredentialToServer(state: DemoState): Promise<ActionResult> {
  const challenge = state.challenge
  const credential = state.credential
  if (!challenge) throw new Error('Server-issued challenge required (step 1).')
  if (!credential) throw new Error('Credential required (step 2).')

  const resp = await fetch(state.serverEndpoint, {
    method: 'GET',
    headers: { Authorization: credential },
  })
  if (resp.status !== 200) {
    const body = await resp.text().catch(() => '<no body>')
    // hash already has an on-chain side effect (the transfer is broadcast) —
    // surface the EXACT credential so it can be reconciled / resubmitted
    // rather than rebuilt (rebuilding re-signs / re-broadcasts). Mirrors the
    // SDK PaymentSideEffectError.
    throw new Error(
      `Server rejected the credential: HTTP ${resp.status} ${resp.statusText}. ` +
        `Body: ${body.slice(0, 500)}. ` +
        `The credential is already built (a hash credential's transfer is already broadcast) — ` +
        `reconcile / resubmit this exact value, do not rebuild:\n${credential}`,
    )
  }
  const receiptHeader = resp.headers.get('Payment-Receipt')
  if (!receiptHeader) {
    throw new Error(
      "Server returned 200 but no Payment-Receipt header — verifier ran but didn't emit a receipt.",
    )
  }
  let receipt: ReturnType<typeof deserializeEvmReceipt>
  try {
    receipt = deserializeEvmReceipt(receiptHeader)
  } catch (cause) {
    throw new Error(`deserializeEvmReceipt rejected the server's Payment-Receipt header.`, {
      cause,
    })
  }

  const challengeIdOk = receipt.challengeId === challenge.id
  const req = challenge.request as { methodDetails: { chainId: number } }
  const chainIdOk = receipt.chainId === req.methodDetails.chainId
  const statusOk = receipt.status === 'success'
  const allOk = challengeIdOk && chainIdOk && statusOk

  const respBody = await resp.json().catch(() => null)
  const explorerLink = receipt.reference ? explorerTxUrl(receipt.chainId, receipt.reference) : null

  const body = (
    <div className="space-y-3">
      <div className={allOk ? 'text-xs text-emerald-300' : 'text-xs text-amber-300'}>
        {allOk
          ? '✓ End-to-end flow complete.'
          : '⚠ Receipt fields do not match the challenge — investigate.'}
      </div>
      <ul className="space-y-1 text-xs">
        <li>
          • receipt.challengeId === challenge.id:{' '}
          <span className={challengeIdOk ? 'font-mono text-emerald-400' : 'font-mono text-red-400'}>
            {String(challengeIdOk)}
          </span>
        </li>
        <li>
          • receipt.chainId === request.methodDetails.chainId:{' '}
          <span className={chainIdOk ? 'font-mono text-emerald-400' : 'font-mono text-red-400'}>
            {String(chainIdOk)}
          </span>
        </li>
        <li>
          • receipt.status === 'success':{' '}
          <span className={statusOk ? 'font-mono text-emerald-400' : 'font-mono text-red-400'}>
            {String(statusOk)}
          </span>
        </li>
      </ul>
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
      <div className="text-xs text-muted-foreground">Decoded receipt:</div>
      <JsonBlock value={receipt} />
      {respBody && (
        <>
          <div className="text-xs text-muted-foreground">Response body:</div>
          <JsonBlock value={respBody} />
        </>
      )}
    </div>
  )

  return {
    patch: { receiptHeader },
    panel: panel(
      'Server settled the credential — HTTP 200 + Payment-Receipt',
      body,
      allOk ? 'ok' : 'warn',
    ),
  }
}
