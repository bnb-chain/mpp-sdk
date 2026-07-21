/**
 * Merchant-side B402 Exact handler.
 *
 * The public interface supports exactly two transfer methods:
 * `eip3009` and `permit2-exact`. Both travel over the same x402 v2 envelope
 * and share the same trust boundary: the merchant owns the requirements,
 * reconstructs the facilitator payload, and judges the settlement echo before
 * releasing content.
 */

import type { FacilitatorRequest } from './Client.js'
import { decodeXPayment, encodeXPaymentResponse, isEip3009PaymentPayload } from './Payload.js'
import { isPermit2PaymentPayload } from './Permit2.js'
import { parseSettleResult, parseSupportedResponse, parseVerifyResult } from './Response.js'
import { B402SupportedCache } from './Supported.js'
import {
  X402_VERSION,
  type BazaarMetadata,
  type Eip3009PaymentPayload,
  type PaymentPayload,
  type PaymentRequiredBody,
  type PaymentRequirements,
  type Permit2PaymentPayload,
  type ResourceInfo,
  type SettleResult,
  type SupportedResponse,
  type VerifyResult,
} from './Types.js'

export const B402_EXACT_METHODS = ['eip3009', 'permit2-exact'] as const
export type B402ExactMethod = (typeof B402_EXACT_METHODS)[number]

export interface B402ExactClient {
  supported(): Promise<SupportedResponse>
  verify(request: FacilitatorRequest): Promise<VerifyResult>
  settle(request: FacilitatorRequest): Promise<SettleResult>
}

/** Authoritative payment values resolved by the merchant application. */
export interface B402ExactPayment {
  readonly network: string
  readonly asset: { readonly address: `0x${string}`; readonly name: string }
  readonly payTo: `0x${string}`
  readonly amount: string | bigint
  /** Per-resource override. Defaults to the extension/handler method order. */
  readonly methods?: readonly B402ExactMethod[]
  readonly maxTimeoutSeconds?: number
  readonly resource?: ResourceInfo
  /** Merchant-owned metadata. Buyer-provided extensions are never forwarded. */
  readonly bazaar?: BazaarMetadata
}

export interface B402SettlementUnknown {
  readonly status: 'unknown'
  readonly phase: 'settle'
  readonly reason: string
  readonly requirements: PaymentRequirements
  /** Exact signed request submitted to B402. Store it securely if reconciliation is required. */
  readonly request: FacilitatorRequest
  readonly cause?: unknown
}

export type B402ExactResult =
  | {
      readonly paid: false
      readonly response: Response
      readonly settlement?: B402SettlementUnknown
    }
  | {
      readonly paid: true
      readonly method: B402ExactMethod
      readonly settlement: SettleResult
      readonly withPaymentResponse: (response: Response) => Response
    }

export interface B402ExactHandlerOptions {
  readonly client: B402ExactClient
  readonly resolvePayment: (request: Request) => B402ExactPayment | Promise<B402ExactPayment>
  /** Preference/order advertised when a payment supports both methods. */
  readonly methods?: readonly B402ExactMethod[]
  readonly supportedCache?: B402SupportedCache
  readonly onSettlementUnknown?: (context: B402SettlementUnknown) => void | Promise<void>
}

export interface B402FixedExactHandlerOptions extends B402ExactPayment {
  readonly client: B402ExactClient
  readonly supportedCache?: B402SupportedCache
  readonly onSettlementUnknown?: B402ExactHandlerOptions['onSettlementUnknown']
}

export interface B402ExactHandler {
  (request: Request): Promise<B402ExactResult>
}

export interface B402FixedExactHandler extends B402ExactHandler {
  readonly requirements: readonly PaymentRequirements[]
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function normalizeMethods(
  methods: readonly B402ExactMethod[] | undefined,
  label: string,
): readonly B402ExactMethod[] {
  const resolved = methods ?? B402_EXACT_METHODS
  if (resolved.length === 0) throw new Error(`${label}: methods must not be empty`)
  const unique: B402ExactMethod[] = []
  for (const method of resolved) {
    if (!B402_EXACT_METHODS.includes(method)) {
      throw new Error(`${label}: unsupported B402 Exact method '${String(method)}'`)
    }
    if (!unique.includes(method)) unique.push(method)
  }
  return unique
}

function atomicAmount(amount: string | bigint, label: string): string {
  const value = typeof amount === 'bigint' ? amount.toString() : amount
  if (!/^\d+$/.test(value) || BigInt(value) <= 0n) {
    throw new Error(`${label}: amount must be a positive integer in atomic units (got '${amount}')`)
  }
  return value
}

function requirementsFor(
  payment: B402ExactPayment,
  supported: SupportedResponse,
  defaultMethods: readonly B402ExactMethod[],
  label: string,
): readonly PaymentRequirements[] {
  const amount = atomicAmount(payment.amount, label)
  const methods = normalizeMethods(payment.methods ?? defaultMethods, label)
  const requirements: PaymentRequirements[] = []

  for (const method of methods) {
    const kind = supported.kinds.find(
      (candidate) =>
        candidate.x402Version === X402_VERSION &&
        candidate.scheme === 'exact' &&
        candidate.network === payment.network &&
        candidate.extra.assetTransferMethod === method &&
        candidate.extra.name === payment.asset.name,
    )
    // A token may support only one of the configured methods. Advertising the
    // supported intersection is intentional; an empty intersection is a boot /
    // resource configuration error below.
    if (!kind) continue
    requirements.push({
      scheme: 'exact',
      network: payment.network,
      amount,
      asset: payment.asset.address,
      payTo: payment.payTo,
      maxTimeoutSeconds: payment.maxTimeoutSeconds ?? 300,
      extra: kind.extra,
    })
  }

  if (requirements.length === 0) {
    const requested = methods.map((method) => `exact/${method}`).join(' or ')
    throw new Error(
      `${label}: b402 /supported has no ${requested} kind named '${payment.asset.name}' ` +
        `on ${payment.network} — asset.name must equal the token EIP-712 domain name`,
    )
  }
  return requirements
}

function sameAddress(a: string | undefined, b: string | undefined): boolean {
  return a === undefined || b === undefined ? a === b : a.toLowerCase() === b.toLowerCase()
}

/** Every field is merchant-owned; partial pinning lets unsigned metadata drift. */
function sameRequirements(a: PaymentRequirements, b: PaymentRequirements): boolean {
  return (
    a.scheme === b.scheme &&
    a.network === b.network &&
    a.amount === b.amount &&
    sameAddress(a.asset, b.asset) &&
    sameAddress(a.payTo, b.payTo) &&
    a.maxTimeoutSeconds === b.maxTimeoutSeconds &&
    a.extra.name === b.extra.name &&
    a.extra.version === b.extra.version &&
    a.extra.assetTransferMethod === b.extra.assetTransferMethod &&
    sameAddress(a.extra.signerAddress, b.extra.signerAddress) &&
    sameAddress(a.extra.spenderAddress, b.extra.spenderAddress)
  )
}

function invalidSettlementSuccessReason(
  settlement: SettleResult,
  requirements: PaymentRequirements,
  expectedPayer: string,
): string | undefined {
  if (!/^0x[0-9a-fA-F]{64}$/.test(settlement.transaction)) {
    return `b402 reported success but returned no/invalid tx hash (${JSON.stringify(settlement.transaction)})`
  }
  if (!settlement.amount) return 'b402 reported success but echoed no settled amount'
  if (settlement.amount !== requirements.amount) {
    return `b402 reported success for amount ${settlement.amount}, expected ${requirements.amount}`
  }
  if (settlement.network !== requirements.network) {
    return `b402 reported success on network ${settlement.network}, expected ${requirements.network}`
  }
  if (settlement.payer.toLowerCase() !== expectedPayer.toLowerCase()) {
    return `b402 reported success for payer ${settlement.payer}, expected ${expectedPayer}`
  }
  return undefined
}

function reconstructPayment(
  decoded: unknown,
  requirements: PaymentRequirements,
): { method: B402ExactMethod; payload: PaymentPayload; payer: string } | undefined {
  if (isEip3009PaymentPayload(decoded)) {
    if (requirements.extra.assetTransferMethod !== 'eip3009') return undefined
    const authorization = decoded.payload.authorization
    const payload: Eip3009PaymentPayload = {
      x402Version: X402_VERSION,
      accepted: requirements,
      payload: {
        signature: decoded.payload.signature,
        authorization: {
          from: authorization.from,
          to: requirements.payTo,
          value: requirements.amount,
          validAfter: authorization.validAfter,
          validBefore: authorization.validBefore,
          nonce: authorization.nonce,
        },
      },
    }
    return { method: 'eip3009', payload, payer: authorization.from }
  }

  if (isPermit2PaymentPayload(decoded)) {
    if (requirements.extra.assetTransferMethod !== 'permit2-exact') return undefined
    const authorization = decoded.payload.permit2Authorization
    const payload: Permit2PaymentPayload = {
      x402Version: X402_VERSION,
      accepted: requirements,
      payload: {
        signature: decoded.payload.signature,
        permit2Authorization: {
          permitted: { token: requirements.asset, amount: requirements.amount },
          from: authorization.from,
          spender: requirements.extra.spenderAddress as `0x${string}`,
          nonce: authorization.nonce,
          deadline: authorization.deadline,
          witness: { to: requirements.payTo, validAfter: authorization.witness.validAfter },
        },
      },
    }
    return { method: 'permit2-exact', payload, payer: authorization.from }
  }
  return undefined
}

async function notifyUnknown(
  callback: B402ExactHandlerOptions['onSettlementUnknown'],
  context: B402SettlementUnknown,
): Promise<void> {
  // The payment is already ambiguous. A persistence-hook failure must not hide
  // the structured result from the caller.
  await Promise.resolve(callback?.(context)).catch(() => undefined)
}

async function handleExact(
  request: Request,
  requirementsList: readonly PaymentRequirements[],
  payment: B402ExactPayment,
  client: B402ExactClient,
  onSettlementUnknown: B402ExactHandlerOptions['onSettlementUnknown'],
): Promise<B402ExactResult> {
  const paymentRequired = (error: string): PaymentRequiredBody => ({
    x402Version: X402_VERSION,
    error,
    accepts: requirementsList,
    ...(payment.resource ? { resource: payment.resource } : {}),
  })

  const header = request.headers.get('X-PAYMENT')
  if (!header) {
    return { paid: false, response: json(402, paymentRequired('payment required')) }
  }

  let decoded: unknown
  try {
    decoded = decodeXPayment(header)
  } catch {
    return { paid: false, response: json(400, { error: 'X-PAYMENT is not valid base64 JSON' }) }
  }

  // Validate the complete nested shape before reading `accepted.extra` in the
  // requirement comparison. A truncated hostile object must produce 400, not a
  // property-access exception/500.
  let validated: Eip3009PaymentPayload | Permit2PaymentPayload
  if (isEip3009PaymentPayload(decoded)) validated = decoded
  else if (isPermit2PaymentPayload(decoded)) validated = decoded
  else {
    return {
      paid: false,
      response: json(400, { error: 'X-PAYMENT is not a supported well-formed B402 Exact payload' }),
    }
  }
  const chosen = requirementsList.find((requirements) =>
    sameRequirements(validated.accepted, requirements),
  )
  if (!chosen) {
    return {
      paid: false,
      response: json(400, { error: "accepted does not match this endpoint's requirements" }),
    }
  }

  // The validators above gate the signed/accepted cross-field equalities before
  // the merchant authenticates anything to B402.
  const reconstructed = reconstructPayment(validated, chosen)
  if (!reconstructed) {
    return {
      paid: false,
      response: json(400, { error: 'X-PAYMENT is not a supported well-formed B402 Exact payload' }),
    }
  }

  const verifyRequest: FacilitatorRequest = {
    x402Version: X402_VERSION,
    paymentPayload: reconstructed.payload,
    paymentRequirements: chosen,
  }
  let verify: VerifyResult
  try {
    verify = parseVerifyResult(await client.verify(verifyRequest))
  } catch {
    return {
      paid: false,
      response: json(502, {
        error: 'b402 verify unreachable; nothing was settled; retry later',
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
  if (verify.payer.toLowerCase() !== reconstructed.payer.toLowerCase()) {
    return {
      paid: false,
      response: json(502, {
        error: `b402 verify reported a payer that does not match the signed payment; nothing was settled`,
      }),
    }
  }

  const settleRequest: FacilitatorRequest = {
    ...verifyRequest,
    paymentPayload: payment.bazaar
      ? { ...reconstructed.payload, extensions: { bazaar: payment.bazaar } }
      : reconstructed.payload,
  }
  let settlement: SettleResult
  try {
    settlement = parseSettleResult(await client.settle(settleRequest))
  } catch (cause) {
    const unknown: B402SettlementUnknown = {
      status: 'unknown',
      phase: 'settle',
      reason: 'b402 settle transport/response failure; the transfer may already be on-chain',
      requirements: chosen,
      request: settleRequest,
      cause,
    }
    await notifyUnknown(onSettlementUnknown, unknown)
    return {
      paid: false,
      settlement: unknown,
      response: json(502, {
        error:
          'b402 settlement state UNKNOWN; reconcile the signed request/on-chain transfer before treating it as unpaid',
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

  const invalidSuccess = invalidSettlementSuccessReason(settlement, chosen, reconstructed.payer)
  if (invalidSuccess) {
    const unknown: B402SettlementUnknown = {
      status: 'unknown',
      phase: 'settle',
      reason: invalidSuccess,
      requirements: chosen,
      request: settleRequest,
    }
    await notifyUnknown(onSettlementUnknown, unknown)
    return {
      paid: false,
      settlement: unknown,
      response: json(502, {
        error: `${invalidSuccess}; settlement state UNKNOWN — reconcile before fulfillment`,
      }),
    }
  }

  return {
    paid: true,
    method: reconstructed.method,
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

/**
 * Dynamic merchant handler. The application resolves price/order values on
 * both the probe and paid retry; the resulting requirements are pinned before
 * any facilitator call.
 */
export function createB402ExactHandler(options: B402ExactHandlerOptions): B402ExactHandler {
  const supportedCache = options.supportedCache ?? new B402SupportedCache(options.client)
  const methods = normalizeMethods(options.methods, 'createB402ExactHandler')
  return async (request: Request): Promise<B402ExactResult> => {
    const payment = await options.resolvePayment(request)
    const supported = await supportedCache.get()
    const requirements = requirementsFor(payment, supported, methods, 'createB402ExactHandler')
    return handleExact(request, requirements, payment, options.client, options.onSettlementUnknown)
  }
}

/** Fixed-price variant that resolves `/supported` at creation. */
export async function createFixedB402ExactHandler(
  options: B402FixedExactHandlerOptions,
  internalLabel = 'createFixedB402ExactHandler',
): Promise<B402FixedExactHandler> {
  const methods = normalizeMethods(options.methods, internalLabel)
  const supported = options.supportedCache
    ? await options.supportedCache.get()
    : parseSupportedResponse(await options.client.supported())
  const requirements = requirementsFor(options, supported, methods, internalLabel)
  const handler = (request: Request): Promise<B402ExactResult> =>
    handleExact(request, requirements, options, options.client, options.onSettlementUnknown)
  return Object.assign(handler, { requirements })
}
