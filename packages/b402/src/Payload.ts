/**
 * Browser-safe B402 provider primitives: build + sign an EIP-3009 payment
 * payload and encode/decode the underlying x402 headers. EIP-712 typed data is
 * local to the Provider Module so direct x402 users do not depend on MPP.
 *
 * Only viem + Web Crypto are used here, so this runs in the browser (sign via a
 * connected wallet) and in Node alike. Native x402 callers normally use a
 * random 32-byte nonce; adapters may supply a deterministic nonce when they
 * need to bind the proof to an external request or challenge.
 */

import {
  type Hex,
  type LocalAccount,
  compactSignatureToSignature,
  parseCompactSignature,
  recoverTypedDataAddress,
  serializeSignature,
  toHex,
} from 'viem'

import { eip3009Domain, eip3009Types } from './TypedData.js'
import {
  X402_VERSION,
  type Eip3009Authorization,
  type Eip3009PaymentPayload,
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResult,
} from './Types.js'

export interface BuildEip3009PaymentOptions {
  /**
   * The signer — its `address` becomes `authorization.from` and the on-chain
   * debit address. In the browser, wrap a wagmi/viem wallet client as a
   * `LocalAccount` whose `signTypedData` defers to the connected wallet.
   */
  readonly account: LocalAccount
  /** The chosen `accepts[]` entry from the merchant's 402 (must be eip3009). */
  readonly requirements: PaymentRequirements
  /** Optional ResourceInfo `url` for traceability (x402 v2 §5.1). */
  readonly resourceUrl?: string
  /** EIP-3009 `validAfter`, unix seconds. Default `"0"` (valid immediately). */
  readonly validAfter?: string | bigint
  /**
   * EIP-3009 `validBefore`, unix seconds. Default `now + maxTimeoutSeconds`
   * (the merchant's settlement window).
   */
  readonly validBefore?: string | bigint
  /**
   * Hard upper bound (seconds from now) the buyer is willing to leave the
   * signed authorization redeemable — a ceiling the buyer sets, independent
   * of the merchant-supplied `maxTimeoutSeconds` (audit L03). Defaults to
   * `DEFAULT_MAX_SETTLEMENT_SEC` (24h). A tampered challenge declaring
   * `maxTimeoutSeconds` of, say, 100 years cannot mint a long-lived "zombie
   * authorization": the computed `validBefore` is clamped to
   * `now + maxSettlementSeconds`.
   */
  readonly maxSettlementSeconds?: number
  /**
   * Optional caller-supplied nonce. Native B402/x402 callers normally leave
   * this unset for a random nonce. Protocol adapters may derive it from an
   * external challenge to prevent cross-request replay.
   */
  readonly nonce?: Hex
}

/**
 * Default buyer-side settlement-window ceiling (24h) — a signed
 * authorization stays redeemable at most this long regardless of the
 * merchant-declared `maxTimeoutSeconds` (audit L03).
 */
export const DEFAULT_MAX_SETTLEMENT_SEC = 24 * 60 * 60

/**
 * Sign an EIP-3009 `TransferWithAuthorization` for `requirements` and assemble
 * the x402 v2 `PaymentPayload`. Pass the result to {@link encodeXPayment} for
 * the `X-PAYMENT` header. Rejects non-eip3009 schemes (permit2 needs a
 * one-time approval and a b402-specific witness — out of scope here).
 */
export async function buildEip3009Payment(
  options: BuildEip3009PaymentOptions,
): Promise<Eip3009PaymentPayload> {
  const { account, requirements } = options
  // This SDK models ONLY the x402 `exact` scheme with the `eip3009` transfer
  // method (see Types.ts). Reject anything else rather than sign an `exact`
  // payload for a requirement we did not actually model (e.g. `upto`).
  if (requirements.scheme !== 'exact') {
    throw new Error(
      `buildEip3009Payment: requirements use scheme '${requirements.scheme}', only 'exact' is supported`,
    )
  }
  if (requirements.extra.assetTransferMethod !== 'eip3009') {
    throw new Error(
      `buildEip3009Payment: requirements use '${requirements.extra.assetTransferMethod}', not 'eip3009'`,
    )
  }

  const chainId = chainIdFromNetwork(requirements.network)
  const nowSec = BigInt(Math.floor(Date.now() / 1000))
  const validAfter = options.validAfter !== undefined ? BigInt(options.validAfter) : 0n
  // Buyer-side hard ceiling (audit L03): never leave the authorization
  // redeemable past now + maxSettlementSeconds, regardless of the
  // merchant-declared maxTimeoutSeconds or an explicit validBefore.
  const maxSettlementSeconds = options.maxSettlementSeconds ?? DEFAULT_MAX_SETTLEMENT_SEC
  const settlementCeiling = nowSec + BigInt(maxSettlementSeconds)
  const requestedValidBefore =
    options.validBefore !== undefined
      ? BigInt(options.validBefore)
      : nowSec + BigInt(requirements.maxTimeoutSeconds)
  const validBefore =
    requestedValidBefore < settlementCeiling ? requestedValidBefore : settlementCeiling
  const nonce = options.nonce ?? randomB402Nonce()

  const signature = await account.signTypedData({
    domain: eip3009Domain({
      tokenName: requirements.extra.name,
      tokenVersion: requirements.extra.version,
      chainId,
      tokenAddress: requirements.asset,
    }),
    types: eip3009Types,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: account.address,
      to: requirements.payTo,
      value: BigInt(requirements.amount),
      validAfter,
      validBefore,
      nonce,
    },
  })

  const authorization: Eip3009Authorization = {
    from: account.address,
    to: requirements.payTo,
    value: requirements.amount,
    validAfter: validAfter.toString(),
    validBefore: validBefore.toString(),
    nonce,
  }

  return {
    x402Version: X402_VERSION,
    ...(options.resourceUrl
      ? { resource: { url: options.resourceUrl, mimeType: 'application/json' } }
      : {}),
    accepted: requirements,
    payload: { signature, authorization },
  }
}

/**
 * Recover the payer address from a signed eip3009 `PaymentPayload` — the EIP-712
 * `TransferWithAuthorization` signer. A verifier / facilitator compares this
 * against `payload.payload.authorization.from` and the payment requirements
 * before settling. Reads the domain from `payload.accepted` (what was signed).
 */
export function recoverEip3009Payer(payload: Eip3009PaymentPayload): Promise<`0x${string}`> {
  const { accepted } = payload
  const auth = payload.payload.authorization
  return recoverTypedDataAddress({
    domain: eip3009Domain({
      tokenName: accepted.extra.name,
      tokenVersion: accepted.extra.version,
      chainId: chainIdFromNetwork(accepted.network),
      tokenAddress: accepted.asset,
    }),
    types: eip3009Types,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: auth.from,
      to: auth.to,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce,
    },
    signature: normalizeEip3009Signature(payload.payload.signature),
  })
}

/**
 * Normalize a 64-byte EIP-2098 compact signature to standard 65-byte
 * r||s||v form before recovery (audit I06). `HEX_SIGNATURE` accepts both
 * lengths, but viem's `recoverTypedDataAddress` requires 65 bytes and
 * throws on 64 — so a legitimate compact-signature payer was misclassified
 * as malformed and rejected. 65-byte (130 hex) input passes through
 * unchanged.
 */
function normalizeEip3009Signature(signature: string): Hex {
  const hex = signature as Hex
  if (/^0x[0-9a-fA-F]{128}$/.test(signature)) {
    return serializeSignature(compactSignatureToSignature(parseCompactSignature(hex)))
  }
  return hex
}

/** Encode a PaymentPayload into the base64 `X-PAYMENT` header value. */
export function encodeXPayment(payload: PaymentPayload): string {
  return toBase64(JSON.stringify(payload))
}

/** Decode a base64 `X-PAYMENT` header back into a PaymentPayload (no validation). */
export function decodeXPayment(header: string): PaymentPayload {
  return JSON.parse(fromBase64(header)) as PaymentPayload
}

/** Encode a settlement result into the base64 `X-PAYMENT-RESPONSE` header value. */
export function encodeXPaymentResponse(result: SettleResult): string {
  return toBase64(JSON.stringify(result))
}

/**
 * Decode the base64 `X-PAYMENT-RESPONSE` header into a SettleResult. Returns
 * undefined when the header is absent or malformed — a bad receipt header must
 * never discard an already-paid 200 response.
 */
export function decodeXPaymentResponse(header: string | null): SettleResult | undefined {
  if (!header) return undefined
  try {
    return JSON.parse(fromBase64(header)) as SettleResult
  } catch {
    return undefined
  }
}

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HEX_BYTES32 = /^0x[0-9a-fA-F]{64}$/
/** 64-byte (EIP-2098 compact) or 65-byte EIP-712 signature. */
const HEX_SIGNATURE = /^0x[0-9a-fA-F]{128}([0-9a-fA-F]{2})?$/
const DECIMAL = /^\d+$/
const CAIP2_EIP155 = /^eip155:\d+$/

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}
function isMatch(v: unknown, re: RegExp): boolean {
  return typeof v === 'string' && re.test(v)
}

function sameAddress(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
}

/**
 * Narrow an untrusted decoded value to a well-formed `exact` / `eip3009` /
 * x402-v2 `PaymentPayload`. `decodeXPayment` only JSON-parses + casts, so code
 * handling an attacker-controlled `X-PAYMENT` MUST gate on this before touching
 * nested fields (e.g. {@link recoverEip3009Payer}, which reads `accepted.extra`
 * / `accepted.network` / `accepted.asset` and the `authorization` values).
 *
 * It validates the SHAPE and wire FORMAT of every field those readers depend on
 * — the protocol envelope (`x402Version === 2`, `scheme === 'exact'`, the
 * `eip3009` method), the CAIP-2 network, hex addresses / bytes32 nonce / hex
 * signature, and decimal-string amounts. It does NOT verify the signature is
 * valid or that the payer holds the funds — that is `recoverEip3009Payer` +
 * the facilitator's `/verify` · `/settle`.
 */
export function isEip3009PaymentPayload(value: unknown): value is Eip3009PaymentPayload {
  if (!isRecord(value)) return false
  // Protocol envelope — this SDK models ONLY x402 v2 + exact/eip3009.
  if (value['x402Version'] !== X402_VERSION) return false

  // `accepted` — the PaymentRequirements the payer chose (read when recovering).
  const accepted = value['accepted']
  if (!isRecord(accepted)) return false
  if (accepted['scheme'] !== 'exact') return false
  if (!isMatch(accepted['network'], CAIP2_EIP155)) return false
  if (!isMatch(accepted['amount'], DECIMAL)) return false
  if (!isMatch(accepted['asset'], HEX_ADDRESS)) return false
  if (!isMatch(accepted['payTo'], HEX_ADDRESS)) return false
  const timeout = accepted['maxTimeoutSeconds']
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) return false
  const extra = accepted['extra']
  if (!isRecord(extra)) return false
  if (extra['assetTransferMethod'] !== 'eip3009') return false
  if (typeof extra['name'] !== 'string' || typeof extra['version'] !== 'string') return false
  // signerAddress is the facilitator's on-chain signer — an address, not free text.
  if (!isMatch(extra['signerAddress'], HEX_ADDRESS)) return false

  // `payload` — the signed ExactEvmPayload.
  const payload = value['payload']
  if (!isRecord(payload)) return false
  if (!isMatch(payload['signature'], HEX_SIGNATURE)) return false
  const auth = payload['authorization']
  if (!isRecord(auth)) return false
  if (
    !(
      isMatch(auth['from'], HEX_ADDRESS) &&
      isMatch(auth['to'], HEX_ADDRESS) &&
      isMatch(auth['value'], DECIMAL) &&
      isMatch(auth['validAfter'], DECIMAL) &&
      isMatch(auth['validBefore'], DECIMAL) &&
      isMatch(auth['nonce'], HEX_BYTES32)
    )
  ) {
    return false
  }

  // A syntactically valid authorization for a different recipient or amount
  // cannot satisfy this offer. Reject it before any facilitator call, matching
  // the permit2-exact validator's cross-field pinning.
  return sameAddress(auth['to'], accepted['payTo']) && auth['value'] === accepted['amount']
}

/** A fresh, unguessable 32-byte b402/x402 nonce (random, not challenge-bound). */
export function randomB402Nonce(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)))
}

/** Resolve the EIP-155 chain id from a CAIP-2 network string (`eip155:<id>`). */
export function chainIdFromNetwork(network: string): number {
  const match = /^eip155:(\d+)$/.exec(network)
  const id = match?.[1]
  if (!id) throw new Error(`unsupported CAIP-2 network '${network}' (expected 'eip155:<chainId>')`)
  return Number(id)
}

/* -------------------------------------------------------------------------- */
/*  base64 — Buffer in Node, TextEncoder/btoa in the browser (no polyfill)    */
/* -------------------------------------------------------------------------- */

function toBase64(text: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(text, 'utf8').toString('base64')
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(b64: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(b64, 'base64').toString('utf8')
  const binary = atob(b64)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}
