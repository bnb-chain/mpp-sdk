/**
 * `@bnb-chain/mpp/b402/server` — Node-only b402 facilitator client.
 *
 * Re-exports the browser-safe core (`@bnb-chain/mpp/b402`) plus `B402Client`,
 * which signs every request with the merchant's RSA key (`node:crypto`) and
 * calls the facilitator's `/supported` · `/verify` · `/settle` endpoints —
 * and `createX402Gate`, the one-call standalone-x402 merchant recipe
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
  createX402Gate,
  type X402Gate,
  type X402GateClient,
  type X402GateOptions,
  type X402GateResult,
} from '../Gate.js'
