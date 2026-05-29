/**
 * Custom HTTP transport that preserves draft-evm-charge-00 §7.6 fields on
 * the `Payment-Receipt` header (spec §13.4.1 path C2).
 *
 * Background: mppx's default `Transport.http()` writes the receipt via
 * `Receipt.serialize(receipt)` = `base64url(JSON.stringify(receipt))`. While
 * structural JSON.stringify happens to preserve `challengeId` / `chainId`
 * today, any future mppx version that inserts `Receipt.from(...)` (which
 * routes through the mppx schema and strips unknown fields) on the HTTP
 * path would silently drop those two fields. The whole point of the C2
 * path is to make wire output DETERMINISTIC and INDEPENDENT of that risk:
 *
 *   1. respondReceipt explicitly calls `serializeEvmReceipt`. Fail-closed:
 *      if a verifier accidentally returned a non-EVM receipt (or an EVM
 *      receipt missing required fields), `assertEvmReceipt` throws BEFORE
 *      the bad header goes on the wire. We intentionally do NOT fall back
 *      to mppx's default — silent fallback would defeat the C2 invariant.
 *   2. Per-method transport override: `charge(...)` factory wires this
 *      automatically (spec §13.4.1 C2 auto-wire). Deployments do NOT pass
 *      `transport` to `Mppx.create({...})` themselves.
 *
 * The deployment's README "Spec Compliance" section documents that C2 is
 * auto-wired; no deployment-side configuration is required.
 */

import { Transport } from 'mppx/server'

import { assertEvmReceipt, serializeEvmReceipt } from './Receipt.js'

/**
 * EVM Charge HTTP transport. Identical to `Transport.http()` except
 * `respondReceipt` is fail-closed for non-EVM-Charge receipts and always
 * encodes via `serializeEvmReceipt`.
 *
 * Carries the name `'evm-http'` so deployment + debugging tools can
 * distinguish it from mppx's default `Transport.http` (which names itself
 * `'http'`).
 */
export function evmHttpTransport(): Transport.Http {
  const baseHttp = Transport.http()

  return Transport.from<Request, Response>({
    ...baseHttp,
    name: 'evm-http',

    respondReceipt({ receipt, response }) {
      // Fail-closed: a verifier that returned a non-EVM receipt (or an
      // EVM receipt missing draft §7.6 fields) must NOT escape silently.
      // Falling back to mppx's default Receipt.serialize here would strip
      // challengeId / chainId — exactly the failure mode C2 exists to
      // prevent (spec §13.4.1).
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
