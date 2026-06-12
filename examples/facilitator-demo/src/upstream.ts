/**
 * The merchant's EXISTING API — exactly as it runs today.
 *
 * Deliberately contains ZERO payment code: no @bnb-chain/mpp, no mppx,
 * no keys, no 402s. This is what a facilitator's merchant already has.
 * The facilitator gateway (`src/facilitator.ts`) sits in front of this
 * process and adds MPP without the merchant changing a line.
 *
 * Run:  pnpm --filter @bnb-chain/mpp-example-facilitator-demo start:upstream
 */

import { serve } from '@hono/node-server'
import { Hono } from 'hono'

const app = new Hono()

// Free endpoint — the gateway passes it through untouched.
app.get('/health', (c) => c.json({ ok: true, service: 'acme-research' }))

// The endpoint the merchant wants to monetize. Note: it trusts its
// network boundary (the gateway); it never sees payment headers.
app.get('/premium-report', (c) =>
  c.json({
    title: 'Acme Research — weekly on-chain stablecoin report',
    highlights: [
      'Machine-to-machine payment volume doubled this quarter',
      'Median paid-API price point: $0.02 per call',
      'Facilitator-routed merchants up 3.1x year-over-year',
    ],
    generatedAt: new Date().toISOString(),
  }),
)

const port = Number.parseInt(process.env.UPSTREAM_PORT ?? '3002', 10)
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[upstream] merchant API (no payment code) on http://localhost:${info.port}`)
  console.log(`[upstream] routes: /premium-report /health`)
})
