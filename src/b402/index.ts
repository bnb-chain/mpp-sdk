/**
 * `@bnb-chain/mpp/b402` — browser-safe core for paying / modeling the Binance
 * OnchainPay (b402) x402 v2 facilitator.
 *
 * Exposes the x402 v2 wire types, the `X-PAYMENT` codec, and
 * `buildEip3009Payment` (sign an EIP-3009 transfer via a wallet / viem account).
 * The server-side credentialed client (`B402Client`, Node `node:crypto`) lives
 * under `@bnb-chain/mpp/b402/server`.
 */

export {
  X402_VERSION,
  type AssetTransferMethod,
  type BazaarMetadata,
  type Eip3009Authorization,
  type ExactEvmPayload,
  type PaymentPayload,
  type PaymentRequirements,
  type PaymentRequirementsExtra,
  type PaymentRequiredBody,
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
