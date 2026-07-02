/**
 * BEFORE — a merchant's existing API, no payments anywhere.
 *
 * This is the starting point of the walkthrough: one ordinary JSON
 * endpoint, the kind every merchant already has. `src/server.ts` is this
 * exact file with MPP added — diff the two to see everything integration
 * takes (the README shows the diff inline).
 *
 * Run:  pnpm --filter @bnb-chain/mpp-example-server start:plain
 * Try:  curl http://localhost:3001/api/premium
 */

import { serve } from '@hono/node-server'
import { Hono } from 'hono'

import './env.js'

const app = new Hono()

app.get('/api/premium', (c) =>
  c.json({
    title: 'BNB Chain stablecoin market snapshot',
    insights: [
      'FDUSD transfer volume up 14% week-over-week',
      'Permit2-based checkout flows now 31% of tracked merchants',
      '$U adoption growing fastest among machine-to-machine payers',
    ],
    generatedAt: new Date().toISOString(),
  }),
)

const port = Number.parseInt(process.env.PORT ?? '3001', 10)
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[merchant-plain] listening on http://localhost:${info.port}`)
  console.log(`[merchant-plain] try: curl http://localhost:${info.port}/api/premium`)
})
