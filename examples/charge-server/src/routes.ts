/**
 * HTTP layer for the charge-server example.
 *
 * `createApp(handlers)` mounts several merchant routes, each demonstrating a
 * different slice of the SDK. Every protected route returns `402 Payment
 * Required` + a `WWW-Authenticate: Payment ...` challenge without a valid
 * credential, and on success settles + returns the content with a
 * `Payment-Receipt` header (draft §7.6).
 *
 *   GET /api/article            fixed 1 USDT (the canonical happy path)
 *   GET /api/download?order=ID  fixed 1 USDT; binds `externalId` into the receipt
 *   GET /api/tip?amount=2.50    dynamic amount, server-validated 0.10–100 USDT
 *   GET /api/split              1 USDT settled as a Permit2 batch (merchant + fee)
 *   GET /api/hash-only          payer-funded: only `transaction` / `hash` accepted
 */

import { chargeFromDecimal } from '@bnb-chain/mpp'
import { Hono, type MiddlewareHandler } from 'hono'

import type { ChargeHandlers, DeploymentConfig } from './handler.js'
import { type GasGuard, pickHandlerForGas } from './hardening.js'

// Server-side tip bounds (USDT base units, 18 decimals). The point of /api/tip
// is that the amount varies per request but the SERVER still enforces policy —
// a client can't request an out-of-range amount.
const TIP_MIN_BASE_UNITS = 100_000_000_000_000_000n // 0.10 USDT
const TIP_MAX_BASE_UNITS = 100_000_000_000_000_000_000n // 100 USDT

export function createApp(
  handlers: ChargeHandlers,
  deployment: DeploymentConfig,
  hardening: { rateLimit: MiddlewareHandler; gasGuard: GasGuard },
): Hono {
  const app = new Hono()

  // Per-IP request throttle — a cheap griefing / DoS guard (draft §10.6).
  app.use('/api/*', hardening.rateLimit)

  // Public (no payment): lets a browser client read this server's actual
  // (chain, token) / credentialTypes / recipient instead of hard-coding them.
  app.get('/api/config', (c) => c.json(deployment))

  app.get('/', (c) =>
    c.text(
      [
        'mpp-sdk charge-server demo. Protected routes (GET; 402 without a valid',
        'Payment credential):',
        '  /api/article             fixed 1 USDT',
        '  /api/download?order=ID   fixed 1 USDT, binds externalId into the receipt',
        '  /api/tip?amount=2.50     dynamic amount, server-validated 0.10-100 USDT',
        '  /api/split               1 USDT split 0.8 merchant / 0.2 fee (Permit2 batch)',
        '  /api/hash-only           payer-funded: only transaction/hash accepted',
        '  /api/stored/article      stored-lookup challenge binding (no HMAC secret)',
        '  /api/config              (public) deployment descriptor — chain/token/credentialTypes',
      ].join('\n'),
    ),
  )

  // ── /api/article — fixed 1 USDT. Gas-gated: when the settlement signer is
  //    low on balance / over its hourly budget, fall back to the payer-funded
  //    handler so the server never sponsors settlement it can't afford
  //    (draft §10.6). No SDK change — just picks between two pre-built handlers.
  app.get('/api/article', async (c) => {
    const handler = await pickHandlerForGas(hardening.gasGuard, handlers.base, handlers.hashOnly)
    const result = await handler.evm.charge({ amount: '1000000000000000000' })(c.req.raw)
    if (result.status === 402) return result.challenge
    return result.withReceipt(
      c.json({
        title: 'Premium Article',
        body: 'Lorem ipsum dolor sit amet — content gated behind 1 USDT.',
        paidAt: new Date().toISOString(),
      }),
    )
  })

  // ── /api/download?order=ID — fixed 1 USDT + externalId. ──
  // `externalId` is a per-route option (spec §10 allows amount/description/
  // externalId to vary). It flows into the draft §7.6 receipt, so the merchant
  // can reconcile the payment against its own order id. Gas-gated like
  // /api/article: degrades to the payer-funded handler when the signer is low.
  app.get('/api/download', async (c) => {
    const order = c.req.query('order')
    if (!order) return c.json({ error: 'missing ?order=<your-order-id>' }, 400)
    const handler = await pickHandlerForGas(hardening.gasGuard, handlers.base, handlers.hashOnly)
    const result = await handler.evm.charge({ amount: '1000000000000000000', externalId: order })(
      c.req.raw,
    )
    if (result.status === 402) return result.challenge
    return result.withReceipt(
      c.json({
        download: `https://example.com/files/${order}.zip`,
        order,
        paidAt: new Date().toISOString(),
      }),
    )
  })

  // ── /api/tip?amount=DECIMAL — dynamic amount, server-enforced bounds. ──
  app.get('/api/tip', async (c) => {
    const raw = c.req.query('amount')
    if (!raw) return c.json({ error: 'missing ?amount=<decimal USDT, e.g. 2.50>' }, 400)
    let baseUnits: string
    try {
      // chargeFromDecimal validates + converts "2.50" -> "2500000000000000000" (18 dec).
      baseUnits = chargeFromDecimal({ amount: raw, decimals: 18 }).amount
    } catch {
      return c.json({ error: `amount "${raw}" is not a valid decimal USDT value` }, 400)
    }
    const n = BigInt(baseUnits)
    if (n < TIP_MIN_BASE_UNITS || n > TIP_MAX_BASE_UNITS) {
      return c.json({ error: 'tip must be between 0.10 and 100 USDT' }, 400)
    }
    // Gas-gated: degrade to the payer-funded handler when the signer is low.
    const handler = await pickHandlerForGas(hardening.gasGuard, handlers.base, handlers.hashOnly)
    const result = await handler.evm.charge({ amount: baseUnits })(c.req.raw)
    if (result.status === 402) return result.challenge
    return result.withReceipt(
      c.json({
        thanks: 'Tip received — much appreciated!',
        amount: raw,
        paidAt: new Date().toISOString(),
      }),
    )
  })

  // ── /api/split — 1 USDT settled as a Permit2 batch (merchant + fee). ──
  // The fee split is configured on the `split` handler (route override of
  // splits is forbidden). Only the permit2 credential carries splits; the
  // client must pick permit2 here. Sponsored-only: there is no payer-funded
  // path for a split, so when the signer can't sponsor we 503 rather than
  // degrade (unlike /api/article, which falls back to hashOnly).
  app.get('/api/split', async (c) => {
    const { canSponsor } = await hardening.gasGuard.snapshot()
    if (!canSponsor) {
      return c.json({ error: 'sponsored settlement temporarily unavailable (server gas low)' }, 503)
    }
    const result = await handlers.split.evm.charge({ amount: '1000000000000000000' })(c.req.raw)
    if (result.status === 402) return result.challenge
    return result.withReceipt(
      c.json({
        ok: true,
        note: 'Settled as a 2-entry Permit2 batch: 0.8 USDT merchant + 0.2 USDT fee.',
        paidAt: new Date().toISOString(),
      }),
    )
  })

  // ── /api/hash-only — payer-funded; only transaction/hash advertised. ──
  // This handler has no settlement signer, so the server never sponsors gas.
  // The challenge advertises only ['transaction', 'hash']; a permit2 /
  // authorization credential is rejected by the accepted-types gate.
  app.get('/api/hash-only', async (c) => {
    const result = await handlers.hashOnly.evm.charge({ amount: '1000000000000000000' })(c.req.raw)
    if (result.status === 402) return result.challenge
    return result.withReceipt(
      c.json({
        ok: true,
        note: 'Payer-funded settlement — the server sponsors no gas.',
        paidAt: new Date().toISOString(),
      }),
    )
  })

  // ── /api/stored/article — stored-lookup challenge binding (HMAC-free). ──
  // The server persisted this challenge at issuance (onChallengeCreated →
  // rememberChallenge); at verify the SDK looks it up by id and constant-time
  // compares its canonical bytes — no HMAC secret needed for the binding
  // (draft §6 zero-deviation path). Sponsored-only here (the handler advertises
  // permit2 / authorization), so 503 when the signer can't sponsor.
  app.get('/api/stored/article', async (c) => {
    const { canSponsor } = await hardening.gasGuard.snapshot()
    if (!canSponsor) {
      return c.json({ error: 'sponsored settlement temporarily unavailable (server gas low)' }, 503)
    }
    const result = await handlers.stored.evm.charge({ amount: '1000000000000000000' })(c.req.raw)
    if (result.status === 402) return result.challenge
    return result.withReceipt(
      c.json({
        title: 'Premium Article (stored-lookup binding)',
        body: 'Same content — but the challenge was bound via the stored-lookup path.',
        paidAt: new Date().toISOString(),
      }),
    )
  })

  return app
}
