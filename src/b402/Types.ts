/**
 * x402 v2 wire types for the Binance OnchainPay (b402) facilitator.
 *
 * b402 is an **x402 v2** facilitator ("CDP wire-shape compatible") — a
 * different HTTP envelope from this SDK's mppx charge flow, but the underlying
 * EIP-3009 credential is the same primitive (`src/protocol/TypedData.ts`).
 * This module models the slice the SDK supports: the `exact` scheme with the
 * `eip3009` OR `permit2-exact` asset-transfer method —
 * `PaymentPayload.payload` is a union of `ExactEvmPayload` (EIP-3009, built by
 * `buildEip3009Payment`) and `Permit2EvmPayload` (permit2-exact, built by
 * `buildPermit2ExactPayment`; ADR-0004). Browser-safe (types only).
 *
 * `permit2-upto` appears in the `AssetTransferMethod` union so `/supported`
 * kinds that advertise it still PARSE, but its payload is deliberately NOT
 * modeled: b402 documents its (different) witness struct as contact-the-team
 * only. The mppx bridge (`B402Adapter`) additionally stays eip3009-only — a
 * b402 Permit2 signature can never double as an mppx `permit2` credential.
 */

/** x402 protocol version. b402 V2 rejects any value other than 2. */
export const X402_VERSION = 2

export type Scheme = 'exact' | 'upto'
export type AssetTransferMethod = 'eip3009' | 'permit2-exact' | 'permit2-upto'

/**
 * Scheme-specific details. For eip3009 this carries the token's EIP-712
 * domain (`name` / `version`) plus the facilitator's `signerAddress`. Copied
 * verbatim from the matching `/supported` `kinds[].extra`.
 *
 * `name` is the token's on-chain EIP-712 domain `name()` — NOT its ticker
 * symbol (e.g. `"United Stables"` for U, `"World Liberty Financial USD"` for
 * USD1, `"U"` for testnet Mock U).
 */
export interface PaymentRequirementsExtra {
  readonly name: string
  readonly version: string
  readonly assetTransferMethod: AssetTransferMethod
  readonly signerAddress: string
  /** Permit2 proxy — present for permit2-*; absent for eip3009. */
  readonly spenderAddress?: string
}

/** A single payment option a merchant advertises (x402 `accepts[]` entry). */
export interface PaymentRequirements {
  readonly scheme: Scheme
  readonly network: string
  /** Amount in the token's atomic units (string). */
  readonly amount: string
  /** Token contract address. */
  readonly asset: `0x${string}`
  /** Merchant payout address — funds settle here on-chain. */
  readonly payTo: `0x${string}`
  readonly maxTimeoutSeconds: number
  readonly extra: PaymentRequirementsExtra
}

export interface ResourceInfo {
  readonly url: string
  readonly description?: string
  readonly mimeType?: string
}

/** EIP-3009 `transferWithAuthorization` arguments — all wire values are strings. */
export interface Eip3009Authorization {
  readonly from: `0x${string}`
  readonly to: `0x${string}`
  readonly value: string
  readonly validAfter: string
  readonly validBefore: string
  /** 32-byte hex nonce. */
  readonly nonce: `0x${string}`
}

/** The `exact`/eip3009 payment payload body (b402 `payload`). */
export interface ExactEvmPayload {
  /** 65-byte EIP-712 signature, 0x-prefixed. */
  readonly signature: `0x${string}`
  readonly authorization: Eip3009Authorization
}

/**
 * Permit2 `PermitWitnessTransferFrom` arguments for `permit2-exact` — the b402
 * "Permit2 Signing Guide" wire shape. All numeric fields are DECIMAL STRINGS on
 * the wire (they sign as uint256 in the EIP-712 typed data). The witness is
 * exactly `Witness { to, validAfter }` — field order and struct name are
 * load-bearing for the typehash. (`permit2-upto` uses a DIFFERENT witness
 * struct and is not modeled — b402 documents it as contact-the-team only.)
 */
export interface Permit2Authorization {
  readonly permitted: { readonly token: `0x${string}`; readonly amount: string }
  readonly from: `0x${string}`
  /** The Permit2 proxy contract (`extra.spenderAddress`) — NOT the facilitator EOA. */
  readonly spender: `0x${string}`
  /** 256-bit random, decimal string (Permit2 unordered nonce bitmap). */
  readonly nonce: string
  /** Unix seconds, decimal string. */
  readonly deadline: string
  readonly witness: { readonly to: `0x${string}`; readonly validAfter: string }
}

/** The `exact`/permit2-exact payment payload body (b402 `payload`). */
export interface Permit2EvmPayload {
  /** 65-byte EIP-712 signature, 0x-prefixed. */
  readonly signature: `0x${string}`
  readonly permit2Authorization: Permit2Authorization
}

/** The full payment object the buyer base64-encodes into the `X-PAYMENT` header. */
export interface PaymentPayload {
  readonly x402Version: number
  readonly resource?: ResourceInfo
  /** The PaymentRequirements the buyer chose to fulfill (echoed from the 402). */
  readonly accepted: PaymentRequirements
  readonly payload: ExactEvmPayload | Permit2EvmPayload
  readonly extensions?: Record<string, unknown>
}

/** A PaymentPayload refined to the eip3009 body (what `buildEip3009Payment` makes). */
export interface Eip3009PaymentPayload extends PaymentPayload {
  readonly payload: ExactEvmPayload
}

/** A PaymentPayload refined to the permit2-exact body (what `buildPermit2ExactPayment` makes). */
export interface Permit2PaymentPayload extends PaymentPayload {
  readonly payload: Permit2EvmPayload
}

/**
 * b402 "Bazaar" discovery metadata — opt-in, sent on `/settle` as
 * `paymentPayload.extensions.bazaar`. b402 persists it for the upcoming public
 * discovery layer; an invalid / unpersisted blob is skipped by the indexer and
 * NEVER fails the settle, so it is safe to attach unconditionally.
 * See https://developers.binance.com/en/docs/products/onchainpay-x402/b402-bazaar
 */
export interface BazaarMetadata {
  /** Discovery payload describing the resource's input / output. */
  readonly info: Record<string, unknown>
  /** JSON Schema (Draft 2020-12) that validates the shape of `info`. */
  readonly schema: Record<string, unknown>
  /** Human-readable resource description. */
  readonly description?: string
  /** Route template for parameterized routes, e.g. `/users/:userId`. */
  readonly routeTemplate?: string
}

/** The body of a `402 Payment Required` response (x402 v2). */
export interface PaymentRequiredBody {
  readonly x402Version: number
  readonly error?: string
  readonly accepts: readonly PaymentRequirements[]
  readonly resource?: ResourceInfo
}

/* -------------------------------------------------------------------------- */
/*  Facilitator (/supported · /verify · /settle) response shapes              */
/* -------------------------------------------------------------------------- */

export interface SupportedKind {
  readonly x402Version: number
  readonly scheme: Scheme
  readonly network: string
  readonly extra: PaymentRequirementsExtra
}

export interface SupportedResponse {
  readonly kinds: readonly SupportedKind[]
  readonly extensions: readonly string[]
  readonly signers: Readonly<Record<string, readonly string[]>>
}

export interface VerifyResult {
  readonly isValid: boolean
  readonly payer: string
  readonly invalidReason?: string
  readonly invalidMessage?: string
}

export interface SettleResult {
  readonly success: boolean
  /** On-chain tx hash; "" when nothing was broadcast (pre-flight rejection). */
  readonly transaction: string
  readonly payer: string
  readonly network: string
  /** Actual settled amount (atomic units) — present on success. */
  readonly amount?: string
  readonly errorReason?: string
  readonly errorMessage?: string
}
