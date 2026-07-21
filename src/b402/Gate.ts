/**
 * Backwards-compatible Permit2 Exact Gate surface.
 *
 * New integrations should use `createB402ExactHandler`, which supports both
 * B402 Exact methods. These wrappers deliberately keep the old callable Gate
 * shape while delegating every security decision to the shared Exact Module.
 */

import {
  type B402ExactClient,
  type B402ExactResult,
  type B402FixedExactHandlerOptions,
  type B402SettlementUnknown,
  createB402ExactHandler,
  createFixedB402ExactHandler,
} from './Exact.js'
import { B402SupportedCache } from './Supported.js'
import type { PaymentRequirements } from './Types.js'

export type X402GateClient = B402ExactClient

export type X402SettlementUnknown = B402SettlementUnknown

export type X402GateResult = B402ExactResult

export type X402GateOptions = Omit<B402FixedExactHandlerOptions, 'methods'>

export interface X402Gate {
  (request: Request): Promise<X402GateResult>
  readonly requirements: PaymentRequirements
}

export type DynamicPermit2ExactPayment = Omit<
  X402GateOptions,
  'client' | 'supportedCache' | 'onSettlementUnknown'
>

export interface DynamicPermit2ExactX402GateOptions {
  readonly client: X402GateClient
  readonly resolvePayment: (
    request: Request,
  ) => DynamicPermit2ExactPayment | Promise<DynamicPermit2ExactPayment>
  readonly supportedCache?: B402SupportedCache
  readonly onSettlementUnknown?: X402GateOptions['onSettlementUnknown']
}

export interface DynamicPermit2ExactX402Gate {
  (request: Request): Promise<X402GateResult>
}

/** Fixed-price compatibility wrapper for B402 `permit2-exact`. */
export async function createPermit2ExactX402Gate(options: X402GateOptions): Promise<X402Gate> {
  const handler = await createFixedB402ExactHandler(
    { ...options, methods: ['permit2-exact'] },
    'createPermit2ExactX402Gate',
  )
  const requirements = handler.requirements[0]
  if (!requirements) {
    // The shared builder guarantees a non-empty list; keep the compatibility
    // shape total if that invariant changes in a future refactor.
    throw new Error('createPermit2ExactX402Gate: no permit2-exact requirements resolved')
  }
  const gate = (request: Request): Promise<X402GateResult> => handler(request)
  return Object.assign(gate, { requirements })
}

/**
 * @deprecated The gate is specifically `permit2-exact`; use
 * `createPermit2ExactX402Gate` or the new `createB402ExactHandler`.
 */
export const createX402Gate = createPermit2ExactX402Gate

/** Dynamic-price compatibility wrapper for B402 `permit2-exact`. */
export function createDynamicPermit2ExactX402Gate(
  options: DynamicPermit2ExactX402GateOptions,
): DynamicPermit2ExactX402Gate {
  const handler = createB402ExactHandler({
    client: options.client,
    methods: ['permit2-exact'],
    resolvePayment: options.resolvePayment,
    ...(options.supportedCache ? { supportedCache: options.supportedCache } : {}),
    ...(options.onSettlementUnknown ? { onSettlementUnknown: options.onSettlementUnknown } : {}),
  })
  return (request: Request): Promise<X402GateResult> => handler(request)
}
