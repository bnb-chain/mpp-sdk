/**
 * Browser-safe b402 payment helpers: build + sign an EIP-3009 `X-PAYMENT`
 * payload, and encode/decode the header. The EIP-712 typed data reuses this
 * SDK's normative `src/protocol/TypedData.ts` (`eip3009Types` / `eip3009Domain`)
 * — the same primitive the mppx `authorization` credential signs, so a single
 * implementation backs both the mppx charge flow and a b402/x402 facilitator.
 *
 * Only viem + Web Crypto are used here, so this runs in the browser (sign via a
 * connected wallet) and in Node alike. The b402-specific bit is the nonce:
 * x402/b402 uses a free random 32-byte nonce (mppx instead binds
 * `nonce = challengeHash`).
 */

import { type Hex, type LocalAccount, recoverTypedDataAddress, toHex } from 'viem'

import { eip3009Domain, eip3009Types } from '../protocol/TypedData.js'
import {
  X402_VERSION,
  type Eip3009Authorization,
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
}

/**
 * Sign an EIP-3009 `TransferWithAuthorization` for `requirements` and assemble
 * the x402 v2 `PaymentPayload`. Pass the result to {@link encodeXPayment} for
 * the `X-PAYMENT` header. Rejects non-eip3009 schemes (permit2 needs a
 * one-time approval and a b402-specific witness — out of scope here).
 */
export async function buildEip3009Payment(
  options: BuildEip3009PaymentOptions,
): Promise<PaymentPayload> {
  const { account, requirements } = options
  if (requirements.extra.assetTransferMethod !== 'eip3009') {
    throw new Error(
      `buildEip3009Payment: requirements use '${requirements.extra.assetTransferMethod}', not 'eip3009'`,
    )
  }

  const chainId = chainIdFromNetwork(requirements.network)
  const nowSec = BigInt(Math.floor(Date.now() / 1000))
  const validAfter = options.validAfter !== undefined ? BigInt(options.validAfter) : 0n
  const validBefore =
    options.validBefore !== undefined
      ? BigInt(options.validBefore)
      : nowSec + BigInt(requirements.maxTimeoutSeconds)
  const nonce = randomB402Nonce()

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
export function recoverEip3009Payer(payload: PaymentPayload): Promise<`0x${string}`> {
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
    signature: payload.payload.signature,
  })
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

/**
 * Narrow an untrusted decoded value to a well-formed eip3009 `PaymentPayload`.
 * `decodeXPayment` only JSON-parses + casts — code handling an attacker-
 * controlled `X-PAYMENT` MUST gate on this before touching nested fields.
 */
export function isEip3009PaymentPayload(value: unknown): value is PaymentPayload {
  if (typeof value !== 'object' || value === null) return false
  const payload = (value as { payload?: unknown }).payload
  if (typeof payload !== 'object' || payload === null) return false
  if (typeof (payload as { signature?: unknown }).signature !== 'string') return false
  const auth = (payload as { authorization?: unknown }).authorization
  if (typeof auth !== 'object' || auth === null) return false
  const a = auth as Record<string, unknown>
  return (
    typeof a['from'] === 'string' &&
    typeof a['to'] === 'string' &&
    typeof a['value'] === 'string' &&
    typeof a['validAfter'] === 'string' &&
    typeof a['validBefore'] === 'string' &&
    typeof a['nonce'] === 'string'
  )
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
