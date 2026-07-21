/**
 * `@bnb-chain/mpp/b402/server` — Node-only b402 facilitator client.
 *
 * Re-exports the browser-safe core (`@bnb-chain/mpp/b402`) plus `B402Client`,
 * which signs every request with the merchant's RSA key (`node:crypto`) and
 * calls the facilitator's `/supported` · `/verify` · `/settle` endpoints —
 * and `createPermit2ExactX402Gate`, the explicitly named one-call
 * standalone-x402 permit2-exact merchant recipe (`createX402Gate` remains a
 * compatibility alias)
 * (402 menu → X-PAYMENT validation → verify → settle → X-PAYMENT-RESPONSE).
 */

export * from '../index.js'

export {
  B402Client,
  B402Error,
  loadRsaPrivateKey,
  signTeslaRequest,
  verifyTeslaSignature,
  type B402Credentials,
  type FacilitatorRequest,
} from '../Client.js'

export {
  createB402ExactHandler,
  createFixedB402ExactHandler,
  type B402ExactClient,
  type B402ExactHandler,
  type B402ExactHandlerOptions,
  type B402ExactPayment,
  type B402ExactResult,
  type B402FixedExactHandler,
  type B402FixedExactHandlerOptions,
  type B402SettlementUnknown,
} from '../Exact.js'

export {
  createDynamicPermit2ExactX402Gate,
  createPermit2ExactX402Gate,
  createX402Gate,
  type DynamicPermit2ExactPayment,
  type DynamicPermit2ExactX402Gate,
  type DynamicPermit2ExactX402GateOptions,
  type X402Gate,
  type X402GateClient,
  type X402GateOptions,
  type X402GateResult,
  type X402SettlementUnknown,
} from '../Gate.js'

export {
  B402SupportedCache,
  type B402SupportedCacheOptions,
  type B402SupportedClient,
  DEFAULT_B402_SUPPORTED_TTL_MS,
} from '../Supported.js'
