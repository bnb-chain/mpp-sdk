/** High-level buyer client for the B402 Exact x402 wire. */

import type { LocalAccount } from 'viem'

import { B402_EXACT_METHODS, type B402ExactMethod } from './Exact.js'
import { buildEip3009Payment, decodeXPaymentResponse, encodeXPayment } from './Payload.js'
import { B402_PERMIT2_ADDRESS, buildPermit2ExactPayment } from './Permit2.js'
import { parsePaymentRequiredBody, parseSettleResult } from './Response.js'
import type { PaymentPayload, PaymentRequirements, SettleResult } from './Types.js'

export interface B402AssetId {
  readonly network: string
  readonly address: `0x${string}`
}

export interface B402BuyerPolicy {
  readonly allowedNetworks?: readonly string[]
  readonly allowedAssets?: readonly B402AssetId[]
  /** Atomic-unit ceiling. This intentionally does not guess token decimals. */
  readonly maxAmountBase?: string | bigint
}

export interface B402Permit2AllowanceQuery {
  readonly network: string
  readonly owner: `0x${string}`
  readonly token: `0x${string}`
  /** ERC-20 allowance target: canonical Permit2, not the B402 proxy spender. */
  readonly spender: typeof B402_PERMIT2_ADDRESS
}

export type B402Permit2AllowanceReader = (
  query: B402Permit2AllowanceQuery,
) => bigint | Promise<bigint>

export interface B402Permit2ApprovalRequest extends B402Permit2AllowanceQuery {
  readonly requiredAmount: bigint
  readonly currentAllowance: bigint
}

/** Thrown before signing when Permit2 needs an explicit ERC-20 approval. */
export class B402Permit2ApprovalRequiredError extends Error {
  readonly approval: B402Permit2ApprovalRequest

  constructor(approval: B402Permit2ApprovalRequest) {
    super(
      `B402 permit2-exact requires an explicit ERC-20 approve to ${approval.spender}; ` +
        `allowance ${approval.currentAllowance} is below ${approval.requiredAmount}`,
    )
    this.name = 'B402Permit2ApprovalRequiredError'
    this.approval = approval
  }
}

/** Paid retry returned a rejection. Reuse/reconcile the exact header; do not re-sign blindly. */
export class B402PaymentRejectedError extends Error {
  readonly response: Response
  readonly paymentHeader: string
  readonly requirements: PaymentRequirements

  constructor(response: Response, paymentHeader: string, requirements: PaymentRequirements) {
    super(`B402 paid retry was rejected with HTTP ${response.status}`)
    this.name = 'B402PaymentRejectedError'
    this.response = response
    this.paymentHeader = paymentHeader
    this.requirements = requirements
  }
}

/** The paid request left the process but no response arrived; settlement may have happened. */
export class B402PaymentSideEffectError extends Error {
  readonly paymentHeader: string
  readonly requirements: PaymentRequirements
  readonly cause: unknown

  constructor(paymentHeader: string, requirements: PaymentRequirements, cause: unknown) {
    super(
      'B402 paid retry failed after sending a signed payment; reconcile or retry the same header',
    )
    this.name = 'B402PaymentSideEffectError'
    this.paymentHeader = paymentHeader
    this.requirements = requirements
    this.cause = cause
  }
}

export interface B402PaymentClientOptions {
  readonly account: LocalAccount
  /** Preference order. Defaults to EIP-3009 first, then Permit2 Exact. */
  readonly methods?: readonly B402ExactMethod[]
  /** Required only when a selected Permit2 Exact offer needs an allowance check. */
  readonly permit2Allowance?: B402Permit2AllowanceReader
  /** Required for Permit2 Exact; keyed by CAIP-2 network. No implicit trust root. */
  readonly trustedSpenders?: Readonly<Record<string, readonly string[]>>
  readonly fetch?: typeof fetch
}

export interface B402PayOptions {
  readonly request?: RequestInit
  readonly policy?: B402BuyerPolicy
}

export type B402PayResult =
  | {
      readonly paymentMade: false
      readonly response: Response
    }
  | {
      readonly paymentMade: true
      readonly response: Response
      readonly method: B402ExactMethod
      readonly requirements: PaymentRequirements
      readonly payment: PaymentPayload
      readonly paymentHeader: string
      readonly settlement?: SettleResult
    }

export interface B402PaymentClient {
  pay(url: string, options?: B402PayOptions): Promise<B402PayResult>
}

function methodsFrom(options: B402PaymentClientOptions): readonly B402ExactMethod[] {
  const methods = options.methods ?? B402_EXACT_METHODS
  if (methods.length === 0) throw new Error('createB402PaymentClient: methods must not be empty')
  const unique: B402ExactMethod[] = []
  for (const method of methods) {
    if (!B402_EXACT_METHODS.includes(method)) {
      throw new Error(`createB402PaymentClient: unsupported method '${String(method)}'`)
    }
    if (!unique.includes(method)) unique.push(method)
  }
  return unique
}

function assertReplayableRequest(request: RequestInit | undefined): void {
  if (!request) return
  const headers = new Headers(request.headers)
  if (headers.has('X-PAYMENT')) {
    throw new Error('B402PaymentClient reserves the X-PAYMENT header for the signed payment')
  }
  const body = request.body
  if (
    body !== undefined &&
    body !== null &&
    typeof ReadableStream !== 'undefined' &&
    body instanceof ReadableStream
  ) {
    throw new Error(
      'B402PaymentClient requires a replayable request body; ReadableStream is not supported',
    )
  }
}

function matchesPolicy(requirements: PaymentRequirements, policy: B402BuyerPolicy): boolean {
  if (policy.allowedNetworks && !policy.allowedNetworks.includes(requirements.network)) return false
  if (
    policy.allowedAssets &&
    !policy.allowedAssets.some(
      (asset) =>
        asset.network === requirements.network &&
        asset.address.toLowerCase() === requirements.asset.toLowerCase(),
    )
  ) {
    return false
  }
  if (
    policy.maxAmountBase !== undefined &&
    BigInt(requirements.amount) > BigInt(policy.maxAmountBase)
  ) {
    return false
  }
  return true
}

function selectRequirements(
  accepts: readonly PaymentRequirements[],
  methods: readonly B402ExactMethod[],
  policy: B402BuyerPolicy,
): { method: B402ExactMethod; requirements: PaymentRequirements } {
  for (const method of methods) {
    const requirements = accepts.find(
      (offer) =>
        offer.scheme === 'exact' &&
        offer.extra.assetTransferMethod === method &&
        matchesPolicy(offer, policy),
    )
    if (requirements) return { method, requirements }
  }
  throw new Error(
    `B402 402 response has no acceptable Exact offer for methods [${methods.join(', ')}]`,
  )
}

function isTrustedSettlement(
  settlement: SettleResult,
  requirements: PaymentRequirements,
  payer: string,
): boolean {
  return (
    settlement.success &&
    /^0x[0-9a-fA-F]{64}$/.test(settlement.transaction) &&
    settlement.payer.toLowerCase() === payer.toLowerCase() &&
    settlement.network === requirements.network &&
    settlement.amount === requirements.amount
  )
}

async function buildPayment(
  method: B402ExactMethod,
  requirements: PaymentRequirements,
  options: B402PaymentClientOptions,
  resourceUrl: string,
): Promise<PaymentPayload> {
  if (method === 'eip3009') {
    return buildEip3009Payment({ account: options.account, requirements, resourceUrl })
  }

  if (!options.permit2Allowance) {
    throw new Error(
      'B402 permit2-exact requires permit2Allowance so the client can fail before signing when approval is missing',
    )
  }
  const allowanceQuery: B402Permit2AllowanceQuery = {
    network: requirements.network,
    owner: options.account.address,
    token: requirements.asset,
    spender: B402_PERMIT2_ADDRESS,
  }
  const allowance = await options.permit2Allowance(allowanceQuery)
  const requiredAmount = BigInt(requirements.amount)
  if (allowance < requiredAmount) {
    throw new B402Permit2ApprovalRequiredError({
      ...allowanceQuery,
      requiredAmount,
      currentAllowance: allowance,
    })
  }
  return buildPermit2ExactPayment({
    account: options.account,
    requirements,
    trustedSpenders: options.trustedSpenders?.[requirements.network] ?? [],
    resourceUrl,
  })
}

/**
 * Create a buyer client that performs probe → offer selection → sign → paid
 * retry. Permit2 approval remains an explicit caller action.
 */
export function createB402PaymentClient(options: B402PaymentClientOptions): B402PaymentClient {
  const methods = methodsFrom(options)
  const doFetch = options.fetch ?? fetch

  return {
    async pay(url: string, payOptions: B402PayOptions = {}): Promise<B402PayResult> {
      assertReplayableRequest(payOptions.request)
      const probe = await doFetch(url, payOptions.request)
      if (probe.status !== 402) return { paymentMade: false, response: probe }

      let body: unknown
      try {
        body = await probe.json()
      } catch {
        throw new Error('B402 402 response body is not valid JSON')
      }
      const offer = parsePaymentRequiredBody(body)
      const { method, requirements } = selectRequirements(
        offer.accepts,
        methods,
        payOptions.policy ?? {},
      )
      const payment = await buildPayment(method, requirements, options, url)
      const paymentHeader = encodeXPayment(payment)
      const headers = new Headers(payOptions.request?.headers)
      headers.set('X-PAYMENT', paymentHeader)

      let response: Response
      try {
        response = await doFetch(url, { ...payOptions.request, headers })
      } catch (cause) {
        throw new B402PaymentSideEffectError(paymentHeader, requirements, cause)
      }
      if (!response.ok) {
        throw new B402PaymentRejectedError(response, paymentHeader, requirements)
      }

      const decodedSettlement = decodeXPaymentResponse(response.headers.get('X-PAYMENT-RESPONSE'))
      let settlement: SettleResult | undefined
      try {
        const parsed = decodedSettlement ? parseSettleResult(decodedSettlement) : undefined
        settlement =
          parsed && isTrustedSettlement(parsed, requirements, options.account.address)
            ? parsed
            : undefined
      } catch {
        // Receipt metadata is useful but cannot invalidate an already-paid 2xx
        // resource response. The exact payment remains available in the result.
        settlement = undefined
      }
      return {
        paymentMade: true,
        response,
        method,
        requirements,
        payment,
        paymentHeader,
        ...(settlement ? { settlement } : {}),
      }
    },
  }
}
