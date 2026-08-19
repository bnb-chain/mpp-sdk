/** Browser-safe B402 provider wire types and payment proof builders. */

export {
  X402_VERSION,
  type AssetTransferMethod,
  type BazaarMetadata,
  type Eip3009Authorization,
  type Eip3009PaymentPayload,
  type ExactEvmPayload,
  type PaymentPayload,
  type PaymentRequirements,
  type PaymentRequirementsExtra,
  type PaymentRequiredBody,
  type Permit2Authorization,
  type Permit2EvmPayload,
  type Permit2PaymentPayload,
  type ResourceInfo,
  type Scheme,
  type SettleResult,
  type SupportedKind,
  type SupportedResponse,
  type VerifyResult,
} from './Types.js'

export {
  DEFAULT_MAX_SETTLEMENT_SEC,
  buildEip3009Payment,
  chainIdFromNetwork,
  decodeXPayment,
  decodeXPaymentResponse,
  encodeXPayment,
  encodeXPaymentResponse,
  isEip3009PaymentPayload,
  randomB402Nonce,
  recoverEip3009Payer,
  type BuildEip3009PaymentOptions,
} from './Payload.js'

export {
  B402_PERMIT2_ADDRESS,
  CURATED_B402_SPENDERS,
  b402Permit2Domain,
  b402Permit2Types,
  buildPermit2ExactPayment,
  isPermit2PaymentPayload,
  recoverPermit2ExactPayer,
  type BuildPermit2ExactPaymentOptions,
} from './Permit2.js'

export {
  parsePaymentRequiredBody,
  parseSettleResult,
  parseSupportedResponse,
  parseVerifyResult,
} from './Response.js'
