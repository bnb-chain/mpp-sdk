/**
 * `createX402Gate` — the standalone-x402 merchant recipe as one call.
 *
 * Wraps the full b402 `permit2-exact` resource lifecycle (docs/b402.md,
 * docs/adr/0004-b402-permit2.md) behind a framework-agnostic
 * `(Request) => X402GateResult` gate:
 *
 *   no `X-PAYMENT` header  → 402 + JSON `accepts[]` menu (extra echoed
 *                            verbatim from `/supported`)
 *   `X-PAYMENT` present    → decode → `isPermit2PaymentPayload` full-shape
 *                            gate → pin the echoed offer against OUR
 *                            requirements → facilitator `/verify` →
 *                            `/settle` → `withPaymentResponse(...)` attaches
 *                            the `X-PAYMENT-RESPONSE` header
 *
 * The kind (incl. the proxy `spenderAddress`) is resolved FRESH from
 * `/supported` at gate creation — the b402 docs warn the spender can change on
 * redeploy, so it is never hard-coded; re-create the gate (restart) to pick up
 * a redeploy. Exported via `@bnb-chain/mpp/b402/server` (the gate needs a
 * credentialed facilitator client), core-free like the rest of the b402
 * modules.
 *
 * SECURITY: the `X-PAYMENT` header is attacker-controlled input. The gate
 * validates the full payload shape (including the cross-field equalities)
 * BEFORE any network call, and pins every buyer-echoed requirement field
 * (asset / payTo / amount / network / spender) to the gate's own values — a
 * payload that self-consistently names a different spender or recipient is
 * rejected locally, not forwarded.
 */

import type { FacilitatorRequest } from './Client.js'
import { decodeXPayment, encodeXPaymentResponse } from './Payload.js'
import { isPermit2PaymentPayload } from './Permit2.js'
import {
  X402_VERSION,
  type BazaarMetadata,
  type PaymentRequiredBody,
  type PaymentRequirements,
  type Permit2PaymentPayload,
  type ResourceInfo,
  type SettleResult,
  type SupportedResponse,
  type VerifyResult,
} from './Types.js'

/**
 * The facilitator surface the gate needs — structurally `B402Client`, kept as
 * a minimal interface so tests (and alternative x402 v2 facilitators with the
 * same wire shape) can supply their own.
 */
export interface X402GateClient {
  supported(): Promise<SupportedResponse>
  verify(request: FacilitatorRequest): Promise<VerifyResult>
  settle(request: FacilitatorRequest): Promise<SettleResult>
}

export interface X402GateOptions {
  readonly client: X402GateClient
  /** CAIP-2 network, e.g. `eip155:56`. */
  readonly network: string
  /**
   * The ERC-20 to charge. `name` must equal the b402 `/supported` kind's
   * `extra.name` — the token's EIP-712 domain `name()`, NOT its ticker symbol
   * (e.g. `"United Stables"` for $U, `"USDT Token"` for PancakeSwap
   * TEST_USDT).
   */
  readonly asset: { readonly address: `0x${string}`; readonly name: string }
  /** Merchant payout — funds settle here on-chain. */
  readonly payTo: `0x${string}`
  /** Price per request in the token's atomic units. */
  readonly amount: string | bigint
  /** Advertised validity window; defaults to 300 seconds. */
  readonly maxTimeoutSeconds?: number
  /** Optional ResourceInfo echoed on the 402 body (discovery/traceability). */
  readonly resource?: ResourceInfo
  /**
   * Opt-in b402 "Bazaar" discovery metadata, attached by the GATE (never
   * copied from buyer input) to every `/settle` as
   * `paymentPayload.extensions.bazaar`. Safe to set: b402 skips an invalid
   * blob without failing the settle.
   */
  readonly bazaar?: BazaarMetadata
}

export type X402GateResult =
  | {
      /**
       * Not paid — send `response`: the 402 menu, a 400 (malformed / wrong
       * offer), a 402 rejection, or a 502 when the facilitator itself was
       * unreachable. ⚠️ A 502 from the SETTLE phase means the settlement state
       * is UNKNOWN — b402 may have already broadcast the transfer; reconcile
       * on-chain before treating the payment as absent (a buyer retry is
       * still safe value-wise: the Permit2 nonce is single-use, so a landed
       * transfer cannot be doubled).
       */
      readonly paid: false
      readonly response: Response
    }
  | {
      /** Paid + settled by the facilitator. */
      readonly paid: true
      /** The facilitator's settle echo (tx hash, payer, network, amount). */
      readonly settlement: SettleResult
      /** Return YOUR content through this — it attaches `X-PAYMENT-RESPONSE`. */
      readonly withPaymentResponse: (response: Response) => Response
    }

export interface X402Gate {
  (request: Request): Promise<X402GateResult>
  /**
   * The advertised `accepts[]` entry, resolved at creation — inspect
   * `requirements.extra.spenderAddress` for boot logging / monitoring.
   */
  readonly requirements: PaymentRequirements
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function invalidSettlementSuccessReason(
  settlement: SettleResult,
  requirements: PaymentRequirements,
): string | undefined {
  if (!/^0x[0-9a-fA-F]{64}$/.test(settlement.transaction)) {
    return `b402 reported success but returned no/invalid tx hash (${JSON.stringify(settlement.transaction)})`
  }
  if (!settlement.amount) {
    return 'b402 reported success but echoed no settled amount'
  }
  if (settlement.amount !== requirements.amount) {
    return `b402 reported success for amount ${settlement.amount}, expected ${requirements.amount}`
  }
  if (settlement.network !== requirements.network) {
    return `b402 reported success on network ${settlement.network}, expected ${requirements.network}`
  }
  return undefined
}

/**
 * Resolve the `permit2-exact` kind from `/supported` and return the gate.
 * Throws at creation when the facilitator has no matching kind — a config
 * error (wrong `asset.name` / network / credentials) must fail at boot, not at
 * the first paid request.
 */
export async function createX402Gate(options: X402GateOptions): Promise<X402Gate> {
  const amount = typeof options.amount === 'bigint' ? options.amount.toString() : options.amount
  if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n) {
    throw new Error(
      `createX402Gate: amount must be a positive integer in atomic units (got '${options.amount}')`,
    )
  }

  const supported = await options.client.supported()
  const kind = supported.kinds.find(
    (k) =>
      k.x402Version === X402_VERSION &&
      k.network === options.network &&
      k.scheme === 'exact' &&
      k.extra.assetTransferMethod === 'permit2-exact' &&
      k.extra.name === options.asset.name,
  )
  if (!kind) {
    throw new Error(
      `createX402Gate: b402 /supported has no exact/permit2-exact kind named ` +
        `'${options.asset.name}' on ${options.network} — asset.name must equal the kind's ` +
        `extra.name (the token's EIP-712 domain name, not its symbol)`,
    )
  }

  const requirements: PaymentRequirements = {
    scheme: 'exact',
    network: options.network,
    amount,
    asset: options.asset.address,
    payTo: options.payTo,
    maxTimeoutSeconds: options.maxTimeoutSeconds ?? 300,
    extra: kind.extra, // echoed verbatim — signerAddress + spenderAddress included
  }

  const paymentRequired = (error: string): PaymentRequiredBody => ({
    x402Version: X402_VERSION,
    error,
    accepts: [requirements],
    ...(options.resource ? { resource: options.resource } : {}),
  })

  const gate = async (request: Request): Promise<X402GateResult> => {
    const header = request.headers.get('X-PAYMENT')
    if (!header) {
      // x402 v2: the 402 carries the accepts[] menu as a JSON body.
      return { paid: false, response: json(402, paymentRequired('payment required')) }
    }

    // Attacker-controlled input — gate the full shape (incl. cross-field
    // equalities) BEFORE any network call.
    let payment: unknown
    try {
      payment = decodeXPayment(header)
    } catch {
      return { paid: false, response: json(400, { error: 'X-PAYMENT is not valid base64 JSON' }) }
    }
    if (!isPermit2PaymentPayload(payment)) {
      return {
        paid: false,
        response: json(400, { error: 'X-PAYMENT is not a well-formed permit2-exact payload' }),
      }
    }
    // Pin the buyer-echoed offer to OUR requirements. The validator already
    // proved the payload internally consistent (spender == extra.spenderAddress,
    // witness.to == payTo, ...), so pinning the accepted fields — spender
    // included — pins the signed values too.
    const a = payment.accepted
    if (
      a.asset.toLowerCase() !== requirements.asset.toLowerCase() ||
      a.payTo.toLowerCase() !== requirements.payTo.toLowerCase() ||
      a.amount !== requirements.amount ||
      a.network !== requirements.network ||
      a.extra.spenderAddress?.toLowerCase() !== requirements.extra.spenderAddress?.toLowerCase()
    ) {
      return {
        paid: false,
        response: json(400, { error: "accepted does not match this endpoint's requirements" }),
      }
    }

    // Forward a RECONSTRUCTED payload, never the raw decoded object. The
    // validator checks the fields it names but does not strip unknown ones —
    // and `B402Client` RSA-signs the exact body it sends, so forwarding buyer
    // bytes verbatim would let a paying attacker smuggle their own
    // `extensions.bazaar` (persisted by b402's public discovery index as
    // merchant-attested metadata) or any future field under OUR signature.
    // Rebuilding from the validated fields keeps the EIP-712 signature valid
    // (it covers the typed-data values, not the JSON bytes).
    const auth = payment.payload.permit2Authorization
    const forwarded: Permit2PaymentPayload = {
      x402Version: X402_VERSION,
      accepted: payment.accepted,
      payload: {
        signature: payment.payload.signature,
        permit2Authorization: {
          permitted: { token: auth.permitted.token, amount: auth.permitted.amount },
          from: auth.from,
          spender: auth.spender,
          nonce: auth.nonce,
          deadline: auth.deadline,
          witness: { to: auth.witness.to, validAfter: auth.witness.validAfter },
        },
      },
    }

    let verify: VerifyResult
    try {
      verify = await options.client.verify({
        x402Version: X402_VERSION,
        paymentPayload: forwarded,
        paymentRequirements: requirements,
      })
    } catch (cause) {
      // Verify has no side effects — nothing settled; the buyer may retry.
      return {
        paid: false,
        response: json(502, {
          error: `b402 verify unreachable: ${cause instanceof Error ? cause.message : String(cause)} — nothing was settled; retry later`,
        }),
      }
    }
    if (!verify.isValid) {
      return {
        paid: false,
        response: json(
          402,
          paymentRequired(`b402 verify rejected: ${verify.invalidReason ?? 'unknown'}`),
        ),
      }
    }

    let settlement: SettleResult
    try {
      settlement = await options.client.settle({
        x402Version: X402_VERSION,
        paymentPayload: options.bazaar
          ? { ...forwarded, extensions: { bazaar: options.bazaar } }
          : forwarded,
        paymentRequirements: requirements,
      })
    } catch (cause) {
      // A settle-phase transport failure is AMBIGUOUS: b402 may have already
      // broadcast the transfer before the response was lost. Surface that
      // explicitly instead of throwing — the shipped hosts would turn an
      // exception into a bare 500 with no reconciliation hint. A buyer retry
      // cannot double-spend (the Permit2 nonce is single-use on-chain).
      return {
        paid: false,
        response: json(502, {
          error:
            `b402 settle transport failure: ${cause instanceof Error ? cause.message : String(cause)} — ` +
            `settlement state UNKNOWN (the transfer may still land on-chain); ` +
            `reconcile the recipient's balance / Transfer logs before treating this as unpaid`,
        }),
      }
    }
    if (!settlement.success) {
      return {
        paid: false,
        response: json(
          402,
          paymentRequired(`b402 settle failed: ${settlement.errorReason ?? 'unknown'}`),
        ),
      }
    }
    const invalidSuccess = invalidSettlementSuccessReason(settlement, requirements)
    if (invalidSuccess) {
      return {
        paid: false,
        response: json(502, {
          error: `${invalidSuccess}; settlement state UNKNOWN — reconcile on-chain before treating this as paid or unpaid`,
        }),
      }
    }

    return {
      paid: true,
      settlement,
      withPaymentResponse: (response: Response): Response => {
        const headers = new Headers(response.headers)
        headers.set('X-PAYMENT-RESPONSE', encodeXPaymentResponse(settlement))
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        })
      },
    }
  }

  return Object.assign(gate, { requirements })
}
