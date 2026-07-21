/**
 * Optional fail-closed HTTP transport for draft-evm-charge-00 §7.6 receipts.
 *
 * mppx 0.8.12 changed `Receipt.Schema` to a loose object, so its standard
 * transport now preserves EVM-specific `challengeId` / `chainId` fields.
 * `charge()` therefore uses the host's normal transport. This helper remains
 * useful to custom hosts that want an additional runtime assertion before a
 * receipt is emitted:
 *
 *   1. respondReceipt explicitly calls `serializeEvmReceipt`. Fail-closed:
 *      if a verifier accidentally returned a non-EVM receipt (or an EVM
 *      receipt missing required fields), `assertEvmReceipt` throws BEFORE
 *      the bad header goes on the wire.
 *   2. All other behavior delegates to `Transport.http()`.
 *
 * It is opt-in; normal `charge()` integrations use mppx's host transport.
 */

import { Transport } from 'mppx/server'

import { assertEvmReceipt, serializeEvmReceipt } from './Receipt.js'

/**
 * EVM Charge HTTP transport. Identical to `Transport.http()` except
 * `respondReceipt` is fail-closed for non-EVM-Charge receipts and always
 * encodes via `serializeEvmReceipt`.
 *
 * Carries the name `'evm-http'` so custom deployments can distinguish it
 * from mppx's default `Transport.http` (`'http'`).
 */
export function evmHttpTransport(): Transport.Http {
  const baseHttp = Transport.http()

  return Transport.from<Request, Response>({
    ...baseHttp,
    name: 'evm-http',

    respondReceipt({ receipt, response }) {
      // Fail-closed: a verifier that returned a non-EVM receipt (or an
      // EVM receipt missing draft §7.6 fields) must NOT escape silently.
      // This optional boundary is intentionally stricter than mppx's generic
      // receipt schema: only a complete EVM Charge receipt may pass.
      assertEvmReceipt(receipt)
      const headers = new Headers(response.headers)
      headers.set('Payment-Receipt', serializeEvmReceipt(receipt))
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    },
  })
}
