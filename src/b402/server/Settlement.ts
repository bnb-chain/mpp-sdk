import type { FacilitatorRequest } from '../Client.js'
import type { B402ChargeTransferMethod } from '../Methods.js'
import { parseSettleResult } from '../Response.js'
import type { PaymentRequirements, SettleResult } from '../Types.js'
import type { B402FacilitatorClient } from './Types.js'

export type B402SettlementExpectation = {
  readonly payer: string
  readonly requirements: PaymentRequirements
  readonly transferMethod: B402ChargeTransferMethod
}

/**
 * Durable hand-off emitted when `/settle` may have broadcast a transfer but
 * the SDK cannot prove the final result. The application decides how to store
 * and reconcile this event; this package intentionally owns no order store.
 */
export type B402SettlementUnknownEvent = {
  readonly cause?: unknown
  readonly expectation: B402SettlementExpectation
  readonly phase: 'settle'
  readonly reason: string
  /** Exact, merchant-reconstructed request submitted to B402. */
  readonly request: FacilitatorRequest
  readonly status: 'unknown'
}

export type B402SettlementUnknownHandler = (
  event: B402SettlementUnknownEvent,
) => void | Promise<void>

export class B402SettlementUnknownError extends Error {
  readonly event: B402SettlementUnknownEvent

  constructor(event: B402SettlementUnknownEvent) {
    super(event.reason, { cause: event.cause })
    this.name = 'B402SettlementUnknownError'
    this.event = event
  }
}

/**
 * Calls the irreversible B402 endpoint and classifies only provable success.
 * A transport/parser failure or malformed success is ambiguous, never unpaid.
 */
export async function settleB402(parameters: {
  readonly client: Pick<B402FacilitatorClient, 'settle'>
  readonly expectation: B402SettlementExpectation
  readonly onSettlementUnknown?: B402SettlementUnknownHandler | undefined
  readonly request: FacilitatorRequest
}): Promise<SettleResult> {
  let result: SettleResult
  try {
    result = parseSettleResult(await parameters.client.settle(parameters.request))
  } catch (cause) {
    return throwUnknown(parameters, {
      cause,
      reason: 'B402 settle transport/response failure; the transfer may already be on-chain',
    })
  }

  if (!result.success) return result

  const invalid = invalidSuccessReason(result, parameters.expectation)
  if (invalid) return throwUnknown(parameters, { reason: invalid })
  return result
}

async function throwUnknown(
  parameters: {
    readonly expectation: B402SettlementExpectation
    readonly onSettlementUnknown?: B402SettlementUnknownHandler | undefined
    readonly request: FacilitatorRequest
  },
  details: { readonly cause?: unknown; readonly reason: string },
): Promise<never> {
  const event: B402SettlementUnknownEvent = {
    ...(details.cause !== undefined ? { cause: details.cause } : {}),
    expectation: parameters.expectation,
    phase: 'settle',
    reason: details.reason,
    request: parameters.request,
    status: 'unknown',
  }

  // The settlement is already ambiguous. A persistence/notification callback
  // must not replace the typed error the payment pipeline relies on.
  await Promise.resolve(parameters.onSettlementUnknown?.(event)).catch(() => undefined)
  throw new B402SettlementUnknownError(event)
}

function invalidSuccessReason(
  result: SettleResult,
  expectation: B402SettlementExpectation,
): string | undefined {
  const requirements = expectation.requirements
  if (!/^0x[0-9a-fA-F]{64}$/.test(result.transaction)) {
    return `B402 reported success but returned no/invalid transaction hash (${JSON.stringify(result.transaction)})`
  }
  if (result.amount === undefined) return 'B402 reported success but echoed no settled amount'
  if (result.amount !== requirements.amount) {
    return `B402 reported success for amount ${result.amount}, expected ${requirements.amount}`
  }
  if (result.network !== requirements.network) {
    return `B402 reported success on network ${result.network}, expected ${requirements.network}`
  }
  if (result.payer.toLowerCase() !== expectation.payer.toLowerCase()) {
    return `B402 reported success for payer ${result.payer}, expected ${expectation.payer}`
  }
  return undefined
}
