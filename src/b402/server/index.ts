/**
 * `@bnb-chain/mpp/b402/server` — Node-only b402 facilitator client.
 *
 * Re-exports the browser-safe core (`@bnb-chain/mpp/b402`) plus `B402Client`,
 * which signs every request with the merchant's RSA key (`node:crypto`) and
 * calls the facilitator's `/supported` · `/verify` · `/settle` endpoints.
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
