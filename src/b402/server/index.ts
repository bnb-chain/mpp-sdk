/**
 * `@bnb-chain/mpp/b402/server` — Node-only b402 facilitator client.
 *
 * Re-exports the browser-safe core (`@bnb-chain/mpp/b402`) plus `B402Client`,
 * which signs every request with the merchant's RSA key (`node:crypto`) and
 * calls the facilitator's `/supported` · `/verify` · `/settle` endpoints.
 * `charge` is the MPP-native B402 method and `createB402Facilitator` is the
 * EIP-3009 compatibility Adapter for mppx's standard `evm/charge` method.
 */

export * from '../index.js'

export { charge } from './Charge.js'
export { createB402Facilitator } from './Facilitator.js'
export {
  B402SettlementUnknownError,
  settleB402,
  type B402SettlementExpectation,
  type B402SettlementUnknownEvent,
  type B402SettlementUnknownHandler,
} from './Settlement.js'
export type { B402FacilitatorClient } from './Types.js'

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
  B402SupportedCache,
  type B402SupportedCacheOptions,
  type B402SupportedClient,
  DEFAULT_B402_SUPPORTED_TTL_MS,
} from '../Supported.js'

import { charge } from './Charge.js'

export const b402 = {
  charge,
} as const
