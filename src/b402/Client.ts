/**
 * `B402Client` — a typed, server-side client for the Binance OnchainPay (b402)
 * facilitator (`/supported` · `/verify` · `/settle`), an x402 v2 facilitator.
 *
 * Node-only: every request body is signed with the merchant's RSA key
 * ("Tesla" signing):
 *
 *   to_sign   = body + timestamp                 (exact JSON body ++ ms)
 *   signature = base64( RSA_PKCS1v15_SHA256( to_sign ) )
 *   headers   X-Tesla-ClientId / SignAccessToken / Timestamp / Signature
 *
 * Responses are wrapped in a `{ code, message, data }` envelope (`code`
 * "000000" = success). Application-level failures (an invalid signature, an
 * on-chain revert) still return HTTP 200 — the outcome is in `data`
 * (`isValid` / `success`). Only transport / auth problems surface as non-2xx
 * HTTP, which this client raises as `B402Error`.
 */

import { createPrivateKey, createSign, createVerify, type KeyObject } from 'node:crypto'

import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResult,
  SupportedResponse,
  VerifyResult,
} from './Types.js'

export interface B402Credentials {
  /** e.g. https://cb.binanceapi.com — the per-merchant base URL from onboarding. */
  readonly baseUrl: string
  readonly clientId: string
  readonly accessToken: string
  /**
   * The merchant's RSA private key. Accepts the documented one-line Base64
   * PKCS#8 DER (`private_key.base64`), a Base64-wrapped PEM, or a raw PEM.
   */
  readonly privateKey: string
}

/** A `/verify` or `/settle` request body. `settleAmount` is reserved for the
 *  `permit2-upto` scheme, which this EIP-3009-only client does not build a payload
 *  for yet (kept on the wire type for forward compatibility). */
export interface FacilitatorRequest {
  readonly x402Version: number
  readonly paymentPayload: PaymentPayload
  readonly paymentRequirements: PaymentRequirements
  readonly settleAmount?: string
}

/** Raised on transport / auth / envelope errors (not on `isValid:false`). */
export class B402Error extends Error {
  readonly code: string | undefined
  readonly status: number | undefined
  constructor(message: string, code?: string, status?: number) {
    super(message)
    this.name = 'B402Error'
    this.code = code
    this.status = status
  }
}

/* -------------------------------------------------------------------------- */
/*  Tesla request signing (RSA PKCS#1 v1.5 over SHA-256 of `body + timestamp`) */
/* -------------------------------------------------------------------------- */

/**
 * Load the merchant's RSA private key from the documented Base64 PKCS#8 DER,
 * a Base64-wrapped PEM, or a raw PEM — whichever the operator has on hand.
 */
export function loadRsaPrivateKey(privateKey: string): KeyObject {
  const trimmed = privateKey.trim()
  if (trimmed.includes('-----BEGIN')) {
    return createPrivateKey({ key: trimmed, format: 'pem' })
  }
  const decoded = Buffer.from(trimmed, 'base64')
  if (decoded.toString('utf8', 0, 11) === '-----BEGIN ') {
    return createPrivateKey({ key: decoded.toString('utf8'), format: 'pem' })
  }
  return createPrivateKey({ key: decoded, format: 'der', type: 'pkcs8' })
}

/** Sign `body + timestamp` with the RSA private key (PKCS#1 v1.5 / SHA-256); base64. */
export function signTeslaRequest(privateKey: string, body: string, timestamp: string): string {
  return createSign('RSA-SHA256')
    .update(body + timestamp, 'utf8')
    .end()
    .sign(loadRsaPrivateKey(privateKey), 'base64')
}

/** Verify a Tesla signature against the merchant's RSA public key. */
export function verifyTeslaSignature(
  publicKey: KeyObject,
  body: string,
  timestamp: string,
  signatureB64: string,
): boolean {
  return createVerify('RSA-SHA256')
    .update(body + timestamp, 'utf8')
    .end()
    .verify(publicKey, signatureB64, 'base64')
}

/* -------------------------------------------------------------------------- */
/*  Client                                                                     */
/* -------------------------------------------------------------------------- */

export class B402Client {
  readonly #credentials: B402Credentials

  constructor(credentials: B402Credentials) {
    this.#credentials = credentials
  }

  /** POST /papi/v2/b402/supported — payment kinds + signer addresses (cache it). */
  supported(): Promise<SupportedResponse> {
    return this.#post<SupportedResponse>('/papi/v2/b402/supported', {})
  }

  /** POST /papi/v2/b402/verify — off-chain signature check. No gas, repeatable. */
  verify(request: FacilitatorRequest): Promise<VerifyResult> {
    return this.#post<VerifyResult>('/papi/v2/b402/verify', request)
  }

  /** POST /papi/v2/b402/settle — irreversible on-chain transfer. Verify first. */
  settle(request: FacilitatorRequest): Promise<SettleResult> {
    return this.#post<SettleResult>('/papi/v2/b402/settle', request)
  }

  async #post<T>(path: string, payload: unknown): Promise<T> {
    // Sign the EXACT bytes we send: serialize once, sign body+timestamp, ship body.
    const body = JSON.stringify(payload)
    const timestamp = Date.now().toString()
    const signature = signTeslaRequest(this.#credentials.privateKey, body, timestamp)

    const response = await fetch(`${this.#credentials.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tesla-ClientId': this.#credentials.clientId,
        'X-Tesla-SignAccessToken': this.#credentials.accessToken,
        'X-Tesla-Timestamp': timestamp,
        'X-Tesla-Signature': signature,
      },
      body,
    })

    const text = await response.text()
    if (!response.ok) {
      throw new B402Error(
        `b402 ${path} failed: HTTP ${response.status} ${text}`,
        undefined,
        response.status,
      )
    }

    let envelope: { code?: string; message?: string; data?: T }
    try {
      envelope = JSON.parse(text) as typeof envelope
    } catch {
      throw new B402Error(`b402 ${path}: non-JSON response: ${text}`, undefined, response.status)
    }
    if (envelope.code !== '000000') {
      throw new B402Error(
        `b402 ${path}: code ${envelope.code ?? '(none)'} — ${envelope.message ?? 'no message'}`,
        envelope.code,
        response.status,
      )
    }
    if (envelope.data === undefined) {
      throw new B402Error(
        `b402 ${path}: success envelope had no \`data\``,
        envelope.code,
        response.status,
      )
    }
    return envelope.data
  }
}
