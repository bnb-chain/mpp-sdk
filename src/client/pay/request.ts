/**
 * HTTP probe + retry — the buyer's two round-trips. The caller's own request
 * (method / headers / body — an API token, a POST payload, an `Accept` header)
 * is carried on BOTH the probe and the paid retry; the retry merges
 * `Authorization: Payment <credential>` on top. The body must be replayable
 * (it is sent twice), so a single-use `ReadableStream` is rejected up front.
 */

import { Challenge } from 'mppx'

import type { LogicalPath } from './routes.js'

/** The caller's request shape reused for probe + retry. `body` must be replayable (no stream). */
export interface PayRequestInit {
  /** Defaults to `GET`. A `body` requires an explicit non-GET/HEAD method. */
  readonly method?: string
  /** Sent on BOTH probe and retry (e.g. an API token, `Accept`). `Authorization` is set by the retry. */
  readonly headers?: HeadersInit
  /** Sent on BOTH probe and retry — must be replayable (string / Uint8Array / Blob / URLSearchParams / FormData). */
  readonly body?: BodyInit | null
}

export interface PayResult {
  /** The post-payment response (200 + content on success). */
  readonly response: Response
  /** The route that was selected + settled. */
  readonly route: LogicalPath
  /** Raw `Payment-Receipt` header (decode with `deserializeEvmReceipt` if needed). */
  readonly receiptHeader: string | null
}

/**
 * Thrown when the post-payment retry did NOT succeed (non-2xx) — the buyer may
 * have signed/broadcast, but the server did not accept it, so the caller must
 * NOT treat the result as paid.
 */
export class PaymentRejectedError extends Error {
  readonly status: number
  readonly route: LogicalPath
  readonly body: string
  constructor(status: number, route: LogicalPath, body: string) {
    super(`payment via ${route.id} rejected by the server (HTTP ${status})`)
    this.name = 'PaymentRejectedError'
    this.status = status
    this.route = route
    this.body = body
  }
}

function isBodyless(method: string): boolean {
  return /^(GET|HEAD)$/i.test(method)
}

/** Validate the body can be sent twice (probe + retry). Call once, before the probe. */
export function assertReplayableBody(req?: PayRequestInit): void {
  const body = req?.body
  if (body == null) return
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
    throw new Error(
      'pay(): request.body must be replayable (string / Uint8Array / Blob / URLSearchParams / ' +
        'FormData) — a ReadableStream can only be sent once; buffer it first',
    )
  }
  if (req?.method === undefined || isBodyless(req.method)) {
    throw new Error(
      `pay(): request.body requires an explicit non-GET/HEAD method (got ${req?.method ?? 'GET'})`,
    )
  }
}

/** Method + body common to probe and retry (GET/HEAD carry no body). */
function baseInit(req?: PayRequestInit): { method?: string; body?: BodyInit | null } {
  const out: { method?: string; body?: BodyInit | null } = {}
  if (req?.method !== undefined) out.method = req.method
  if (req?.body != null && req.method !== undefined && !isBodyless(req.method)) out.body = req.body
  return out
}

/** GET (or the caller's request) → deserialize the 402 challenge. No `Authorization`. */
export async function probeChallenge(
  doFetch: typeof fetch,
  url: string,
  req?: PayRequestInit,
): Promise<Challenge.Challenge> {
  const init: RequestInit = { ...baseInit(req) }
  // Only attach headers when the caller supplied some, so a bare probe stays
  // header-free (and stubs can tell probe from retry by Authorization presence).
  if (req?.headers) init.headers = new Headers(req.headers)
  const probe = await doFetch(url, init)
  if (probe.status !== 402) {
    throw new Error(`expected HTTP 402 from ${url}, got ${probe.status}`)
  }
  const wwwAuth = probe.headers.get('WWW-Authenticate')
  if (!wwwAuth) throw new Error('402 without a WWW-Authenticate header')
  return Challenge.deserialize(wwwAuth)
}

/**
 * Retry with `Authorization: Payment <credential>` merged onto the caller's
 * headers. A non-2xx retry is NOT a successful payment — it throws
 * `PaymentRejectedError` rather than returning a result that looks settled.
 */
export async function submitPayment(
  doFetch: typeof fetch,
  url: string,
  req: PayRequestInit | undefined,
  credential: string,
  route: LogicalPath,
): Promise<PayResult> {
  const headers = new Headers(req?.headers)
  headers.set('Authorization', credential)
  const response = await doFetch(url, { ...baseInit(req), headers })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new PaymentRejectedError(response.status, route, body)
  }
  return { response, route, receiptHeader: response.headers.get('Payment-Receipt') }
}
