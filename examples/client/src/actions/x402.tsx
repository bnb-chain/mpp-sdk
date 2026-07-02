/**
 * The x402 tab's four steps — the STANDALONE x402 wire (JSON 402 body +
 * `X-PAYMENT` header), not the mppx charge wire the other tabs speak.
 *
 * This is the b402 `permit2-exact` buyer flow (docs/adr/0004-b402-permit2.md):
 *
 *   1. fetchX402Offer    GET /x402/premium → 402 JSON, pick the permit2-exact
 *                        offer for the selected preset's chain
 *   2. buildX402Payment  one-time on-chain approve(Permit2, max) if allowance
 *                        is short (wallet tx, costs gas ⚠️), then wallet-sign
 *                        the PermitWitnessTransferFrom typed data
 *   3. verifyX402Local   decode + full-shape validate + EIP-712 recover —
 *                        prove the payload is well-formed and ours
 *   4. submitX402Payment GET again with X-PAYMENT → 200 + content +
 *                        X-PAYMENT-RESPONSE (b402's settle tx hash)
 *
 * SECURITY: the 402 body is attacker-controllable input from the buyer's
 * seat (`/supported` is RSA-gated, so a buyer cannot cross-check it). The
 * SDK's `buildPermit2ExactPayment` therefore REQUIRES a spender allowlist —
 * this demo passes the SDK's dated `CURATED_B402_SPENDERS` table — and
 * builds the witness itself from the offer's `payTo`. See the SDK JSDoc.
 */

import {
  B402_PERMIT2_ADDRESS,
  CURATED_B402_SPENDERS,
  buildPermit2ExactPayment,
  chainIdFromNetwork,
  decodeXPayment,
  decodeXPaymentResponse,
  encodeXPayment,
  isPermit2PaymentPayload,
  recoverPermit2ExactPayer,
  type PaymentRequiredBody,
  type PaymentRequirements,
} from '@bnb-chain/mpp/b402'
import { erc20Abi, maxUint256, type Hex } from 'viem'

import { JsonBlock } from '@/components/JsonBlock'
import {
  CHAIN_PRESETS,
  STORAGE_KEYS,
  explorerTxUrl,
  getPresetByKey,
  savePersisted,
} from '@/protocol/presets.js'
import { type DemoState, type VerifyLine } from '@/state/types'

import { type BuildCredentialContext } from './buildCredential'
import { type ActionResult, panel, shortAddr, walletSignerFor } from './shared'

/** The server's standalone x402 route (examples/server mode 3 +
 *  X402_TOKEN_ADDRESS). Same-origin via the vite proxy — override in .env. */
export const X402_ENDPOINT: string = import.meta.env.VITE_X402_ENDPOINT ?? '/x402/premium'

function formatBaseUnits(amount: string, decimals: number): string {
  const big = BigInt(amount)
  const divisor = 10n ** BigInt(decimals)
  const whole = big / divisor
  const frac = big % divisor
  return frac === 0n
    ? whole.toString()
    : `${whole}.${frac.toString().padStart(decimals, '0').replace(/0+$/, '')}`
}

/** The curated spender allowlist for an offer's network ([] when unknown —
 *  the SDK builder then fails closed, which is exactly the point). */
function curatedSpendersFor(network: string): readonly string[] {
  const entry = CURATED_B402_SPENDERS[network]
  return entry ? [entry.exact] : []
}

/* -------------------------------------------------------------------------- */
/*  Step 1 — fetch the 402 JSON and pick the permit2-exact offer               */
/* -------------------------------------------------------------------------- */

export async function fetchX402Offer(state: DemoState): Promise<ActionResult> {
  const preset = getPresetByKey(state.chainKey)
  const network = `eip155:${preset.chainId}`

  const resp = await fetch(X402_ENDPOINT, { method: 'GET' })
  if (resp.status === 404) {
    throw new Error(
      `HTTP 404 from ${X402_ENDPOINT} — the server has no x402 route. Enable it on ` +
        `examples/server: run mode 3 (B402_* env) and set X402_TOKEN_ADDRESS + X402_TOKEN_NAME ` +
        `(see its .env.example), then restart.`,
    )
  }
  if (resp.status !== 402) {
    throw new Error(
      `Expected HTTP 402 from ${X402_ENDPOINT}, got ${resp.status} ${resp.statusText}.`,
    )
  }
  const body = (await resp.json()) as PaymentRequiredBody
  if (!Array.isArray(body.accepts) || body.accepts.length === 0) {
    throw new Error(`402 body from ${X402_ENDPOINT} has no accepts[] offers.`)
  }
  // The wire is untrusted: `extra` is required by b402 but optional in the
  // broader x402 ecosystem — treat it as possibly absent so a spec-legal 402
  // yields a readable error, not a TypeError.
  const accepts = body.accepts as ReadonlyArray<
    Omit<PaymentRequirements, 'extra'> & { extra?: PaymentRequirements['extra'] }
  >

  const offer = accepts.find(
    (a) =>
      a.network === network &&
      a.scheme === 'exact' &&
      a.extra?.assetTransferMethod === 'permit2-exact',
  ) as PaymentRequirements | undefined
  if (!offer) {
    const listed = accepts
      .map((a) => `${a.network}:${a.extra?.assetTransferMethod ?? a.scheme}`)
      .join(', ')
    throw new Error(
      `No exact/permit2-exact offer for ${network} in accepts[] (offers: ${listed}). ` +
        `The chain preset above picks which network's offer this tab accepts — ` +
        `switch it to the server's chain.`,
    )
  }

  const trusted = curatedSpendersFor(offer.network)
  const spenderCurated =
    !!offer.extra.spenderAddress &&
    trusted.some((s) => s.toLowerCase() === offer.extra.spenderAddress?.toLowerCase())

  // Sync the shared form fields the offer pins down. Amount needs decimals,
  // which the x402 wire doesn't carry — only trust a preset that matches the
  // EXACT (chainId, asset) pair (same rule as the mppx fetch action).
  const exactPreset = CHAIN_PRESETS.find(
    (p) => p.chainId === preset.chainId && p.currency.toLowerCase() === offer.asset.toLowerCase(),
  )
  const formSync: ActionResult['formSync'] = { recipient: offer.payTo }
  savePersisted(STORAGE_KEYS.recipient, offer.payTo)
  if (exactPreset) {
    formSync.chainKey = exactPreset.key
    formSync.amountDecimal = formatBaseUnits(offer.amount, exactPreset.decimals)
    savePersisted(STORAGE_KEYS.chainKey, exactPreset.key)
    savePersisted(STORAGE_KEYS.amount, formSync.amountDecimal)
  }

  const bodyNode = (
    <div className="space-y-3">
      <div className="text-xs text-emerald-300">
        ✓ 402 JSON parsed — picked the <code className="font-mono">exact/permit2-exact</code> offer
        for <code className="font-mono">{network}</code>.
      </div>
      <ul className="space-y-1 text-xs">
        <li>
          • asset: <span className="font-mono">{offer.asset}</span>
          {exactPreset && <span className="text-muted-foreground"> ({exactPreset.token})</span>}
        </li>
        <li>
          • amount: <span className="font-mono">{offer.amount}</span> base units
          {exactPreset && (
            <span className="text-muted-foreground">
              {' '}
              = {formatBaseUnits(offer.amount, exactPreset.decimals)} {exactPreset.token}
            </span>
          )}
        </li>
        <li>
          • payTo: <span className="font-mono">{shortAddr(offer.payTo)}</span>
        </li>
        <li>
          • spender: <span className="font-mono">{shortAddr(offer.extra.spenderAddress)}</span>{' '}
          {spenderCurated ? (
            <span className="text-emerald-400">(in the SDK's curated b402 allowlist ✓)</span>
          ) : (
            <span className="text-red-400">
              (NOT in CURATED_B402_SPENDERS — step 2 will refuse to sign)
            </span>
          )}
        </li>
      </ul>
      {!exactPreset && (
        <div className="text-xs text-amber-300">
          The offered asset isn't the selected preset's token — that's fine on the x402 wire (the
          402 is the source of truth), but the amount above is shown in raw base units.
        </div>
      )}
      <JsonBlock value={offer} />
    </div>
  )

  return {
    patch: { x402Offer: offer },
    panel: panel(`x402 offer (HTTP 402 JSON from ${X402_ENDPOINT})`, bodyNode),
    formSync,
  }
}

/* -------------------------------------------------------------------------- */
/*  Step 2 — one-time Permit2 approval (if needed) + wallet-sign the permit    */
/* -------------------------------------------------------------------------- */

export async function buildX402Payment(
  state: DemoState,
  ctx: BuildCredentialContext,
): Promise<ActionResult> {
  const offer = state.x402Offer
  if (!offer) throw new Error('Fetch the x402 offer first (step 1).')
  if (!ctx.walletAddress || !ctx.walletClient || !ctx.publicClient) {
    throw new Error('The x402 permit2 path needs a connected wallet — connect MetaMask first.')
  }
  const offerChainId = chainIdFromNetwork(offer.network)
  if (ctx.walletChainId !== offerChainId) {
    throw new Error(
      `Wallet is on chainId=${ctx.walletChainId}, but the offer is for ${offer.network} ` +
        `(chainId ${offerChainId}). Switch the wallet chain first — the approve tx below ` +
        `would otherwise land on the wrong chain.`,
    )
  }

  // One-time per (wallet, token): the Permit2 contract can only pull funds
  // the token has approved to it. /verify does NOT check this; /settle
  // reverts without it — so the demo checks + fixes it up front.
  const allowance = await ctx.publicClient.readContract({
    address: offer.asset,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [ctx.walletAddress, B402_PERMIT2_ADDRESS],
  })
  let approveTxHash: Hex | null = null
  if (allowance < BigInt(offer.amount)) {
    approveTxHash = await ctx.walletClient.writeContract({
      account: ctx.walletAddress,
      chain: ctx.walletClient.chain ?? null,
      address: offer.asset,
      abi: erc20Abi,
      functionName: 'approve',
      args: [B402_PERMIT2_ADDRESS, maxUint256],
    })
    const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: approveTxHash })
    if (receipt.status !== 'success') {
      throw new Error(
        `approve(Permit2, max) ${approveTxHash} reverted on-chain — no allowance was granted; ` +
          `reconcile before retrying.`,
      )
    }
  }

  // The SDK enforces the ADR-0004 fail-closed rules: spender must be in
  // trustedSpenders (the dated curated table here), the witness is built
  // from offer.payTo (never signed verbatim from the wire), amount is
  // pinned 1:1, deadline capped.
  const signer = walletSignerFor({ address: ctx.walletAddress }, ctx.walletClient)
  const payment = await buildPermit2ExactPayment({
    account: signer,
    requirements: offer,
    trustedSpenders: curatedSpendersFor(offer.network),
    resourceUrl: new URL(X402_ENDPOINT, window.location.origin).toString(),
  })
  const credential = encodeXPayment(payment)

  const explorerLink = approveTxHash ? explorerTxUrl(offerChainId, approveTxHash) : null
  const bodyNode = (
    <div className="space-y-2">
      {approveTxHash ? (
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">
            One-time <code className="font-mono">approve(Permit2, max)</code> mined (allowance was
            short):
          </div>
          <div className="break-all font-mono text-xs text-emerald-300">{approveTxHash}</div>
          {explorerLink && (
            <div className="text-xs">
              <a
                href={explorerLink}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                View approve tx on explorer ↗
              </a>
            </div>
          )}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">
          Permit2 allowance already sufficient — no approve tx needed (it's one-time per wallet +
          token).
        </div>
      )}
      <div className="pt-2 text-xs text-muted-foreground">
        Signed <code className="font-mono">PermitWitnessTransferFrom</code> payload (travels
        base64-encoded in the <code className="font-mono">X-PAYMENT</code> header):
      </div>
      <JsonBlock value={payment} />
    </div>
  )

  return {
    patch: { credential },
    panel: panel('x402 payment — real wallet-signed b402 permit2-exact', bodyNode),
  }
}

/* -------------------------------------------------------------------------- */
/*  Step 3 — local verify: full-shape validator + EIP-712 recover              */
/* -------------------------------------------------------------------------- */

export async function verifyX402Local(state: DemoState): Promise<ActionResult> {
  const offer = state.x402Offer
  const credential = state.credential
  if (!offer) throw new Error('Fetch the x402 offer first (step 1).')
  if (!credential) throw new Error('Build the payment first (step 2).')

  const decoded = decodeXPayment(credential)
  const shapeOk = isPermit2PaymentPayload(decoded)
  const lines: VerifyLine[] = [
    {
      label: 'isPermit2PaymentPayload(decoded X-PAYMENT) — full shape + cross-field equalities',
      ok: shapeOk,
    },
  ]

  let recovered: `0x${string}` | null = null
  if (shapeOk) {
    recovered = await recoverPermit2ExactPayer(decoded)
    const auth = decoded.payload.permit2Authorization
    const trusted = curatedSpendersFor(offer.network)
    lines.push(
      {
        label: 'EIP-712 recover(PermitWitnessTransferFrom) === permit2Authorization.from',
        ok: recovered.toLowerCase() === auth.from.toLowerCase(),
        detail: `recovered ${shortAddr(recovered)}`,
      },
      {
        label: 'spender is in the curated b402 allowlist (CURATED_B402_SPENDERS)',
        ok: trusted.some((s) => s.toLowerCase() === auth.spender.toLowerCase()),
        detail: shortAddr(auth.spender),
      },
      {
        label: 'witness.to === offer.payTo (recipient binding, constructed by the SDK)',
        ok: auth.witness.to.toLowerCase() === offer.payTo.toLowerCase(),
      },
      {
        label: 'permitted.amount === offer.amount (exact, 1:1 — no over-authorization)',
        ok: auth.permitted.amount === offer.amount,
      },
    )
  }

  const allOk = lines.every((l) => l.ok === true)
  const bodyNode = (
    <div className="space-y-2">
      <ul className="space-y-1 text-xs">
        {lines.map((l) => (
          <li key={l.label}>
            •{' '}
            <span className={l.ok === true ? 'text-emerald-400' : 'text-red-400'}>
              {l.ok === true ? '✓' : '✗'}
            </span>{' '}
            {l.label}
            {l.detail && <span className="text-muted-foreground"> — {l.detail}</span>}
          </li>
        ))}
      </ul>
      <div className="pt-1 text-xs text-muted-foreground">
        Signature validity + Permit2 allowance are the facilitator's job (`/verify` · `/settle`);
        these local checks prove the payload is well-formed, ours, and bound to the offer.
      </div>
    </div>
  )

  return {
    patch: { recovered },
    panel: panel(
      allOk ? 'Local verify — payload well-formed + recovers to the wallet' : 'Local verify FAILED',
      bodyNode,
      allOk ? 'ok' : 'warn',
    ),
  }
}

/* -------------------------------------------------------------------------- */
/*  Step 4 — pay: resend with X-PAYMENT, decode X-PAYMENT-RESPONSE             */
/* -------------------------------------------------------------------------- */

export async function submitX402Payment(state: DemoState): Promise<ActionResult> {
  const offer = state.x402Offer
  const credential = state.credential
  if (!offer) throw new Error('Fetch the x402 offer first (step 1).')
  if (!credential) throw new Error('Build the payment first (step 2).')

  const resp = await fetch(X402_ENDPOINT, {
    method: 'GET',
    headers: { 'X-PAYMENT': credential },
  })
  if (resp.status !== 200) {
    const bodyText = await resp.text().catch(() => '<no body>')
    // A 402 (verify/settle rejected before broadcast) means no settlement; a
    // 5xx / gateway error can land AFTER the server already dispatched
    // /settle — so treat settlement state as UNKNOWN, not "not settled".
    throw new Error(
      `Server rejected the payment: HTTP ${resp.status} ${resp.statusText}. ` +
        `Body: ${bodyText.slice(0, 500)}. ` +
        `Settlement state is UNKNOWN for 5xx/timeout failures (the server may have already ` +
        `dispatched /settle) — check the recipient's balance / the token's Transfer logs ` +
        `on-chain before paying again. The signed permit itself stays unusable by anyone ` +
        `but the curated b402 spender, and expires at its deadline.`,
    )
  }

  const responseHeader = resp.headers.get('X-PAYMENT-RESPONSE')
  const settled = decodeXPaymentResponse(responseHeader)
  const chainId = chainIdFromNetwork(offer.network)
  const txHash = (settled?.transaction ?? null) as Hex | null
  const explorerLink = txHash ? explorerTxUrl(chainId, txHash) : null
  const successOk = settled?.success === true
  const payerOk =
    !!settled?.payer &&
    !!state.recovered &&
    settled.payer.toLowerCase() === state.recovered.toLowerCase()

  const respBody = await resp.json().catch(() => null)
  const bodyNode = (
    <div className="space-y-3">
      <div className={successOk ? 'text-xs text-emerald-300' : 'text-xs text-amber-300'}>
        {successOk
          ? '✓ b402 settled the permit2 transfer — end-to-end x402 flow complete.'
          : '⚠ 200 OK but no success=true in X-PAYMENT-RESPONSE — investigate before treating as paid.'}
      </div>
      <ul className="space-y-1 text-xs">
        <li>
          • settled.success === true:{' '}
          <span className={successOk ? 'font-mono text-emerald-400' : 'font-mono text-red-400'}>
            {String(settled?.success ?? 'missing')}
          </span>
        </li>
        <li>
          • settled.payer === recovered signer:{' '}
          <span className={payerOk ? 'font-mono text-emerald-400' : 'font-mono text-amber-400'}>
            {settled?.payer ? String(payerOk) : 'not reported'}
          </span>
        </li>
      </ul>
      {txHash && (
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">Settlement tx (broadcast by b402):</div>
          <div className="break-all font-mono text-xs text-emerald-300">{txHash}</div>
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
        </div>
      )}
      {settled && (
        <>
          <div className="text-xs text-muted-foreground">Decoded X-PAYMENT-RESPONSE:</div>
          <JsonBlock value={settled} />
        </>
      )}
      {respBody != null && (
        <>
          <div className="text-xs text-muted-foreground">Unlocked content:</div>
          <JsonBlock value={respBody} />
        </>
      )}
    </div>
  )

  return {
    patch: {
      ...(responseHeader ? { receiptHeader: responseHeader } : {}),
      ...(txHash ? { settlementTxHash: txHash } : {}),
    },
    panel: panel(
      'Paid over x402 — HTTP 200 + X-PAYMENT-RESPONSE',
      bodyNode,
      successOk ? 'ok' : 'warn',
    ),
  }
}
