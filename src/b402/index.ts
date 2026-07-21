/**
 * `@bnb-chain/mpp/b402` — browser-safe shared Method and provider primitives
 * for Binance OnchainPay (B402).
 *
 * Exposes the `b402/charge` contract, x402 v2 provider types, low-level codecs,
 * `buildEip3009Payment`
 * (sign an EIP-3009 transfer via a wallet / viem account), and
 * `buildPermit2ExactPayment` (sign a b402 `permit2-exact` PermitWitnessTransferFrom
 * — the path for tokens without a usable EIP-3009 door; see ADR-0004).
 * The server-side credentialed client (`B402Client`, Node `node:crypto`) lives
 * under `@bnb-chain/mpp/b402/server`.
 */

export {
  B402_CHARGE_PROTOCOL_VERSION,
  b402ChargeTransferMethods,
  chargeMethod,
  type B402ChargeCredentialPayload,
  type B402ChargeMethodDetails,
  type B402ChargeRequest,
  type B402ChargeTransferMethod,
  type B402Eip3009CredentialPayload,
  type B402Permit2CredentialPayload,
} from './Methods.js'

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
