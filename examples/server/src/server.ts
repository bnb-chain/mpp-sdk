/** Minimal merchant exposing the two MPP-native B402 settlement paths. */

import { B402Client, type B402SettlementUnknownEvent } from '@bnb-chain/b402/server'
import { b402 as b402Server } from '@bnb-chain/mpp-b402/server'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { Mppx } from 'mppx/server'

import './env.js'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing env var ${name}; copy .env.example to .env`)
  return value
}

function requireNonNegativeInteger(name: string, fallback: string): number {
  const raw = process.env[name] ?? fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer (got ${raw})`)
  }
  return value
}

const recipient = requireEnv('RECIPIENT_ADDRESS') as `0x${string}`
const secretKey = requireEnv('MPP_SECRET_KEY')
const priceDecimal = process.env.PRICE_DECIMAL ?? '0.01'

const facilitator = B402Client.fromEnv()
if (!facilitator) {
  throw new Error(
    'Missing B402 facilitator credentials; set B402_BASE_URL, B402_CLIENT_ID, ' +
      'B402_ACCESS_TOKEN, and B402_PRIVATE_KEY.',
  )
}

const b402Charge = await b402Server.charge({
  client: facilitator,
  currency: {
    address: requireEnv('B402_TOKEN_ADDRESS') as `0x${string}`,
    decimals: requireNonNegativeInteger('B402_TOKEN_DECIMALS', '18'),
    name: requireEnv('B402_TOKEN_NAME'),
    version: process.env.B402_TOKEN_VERSION ?? '1',
  },
  network: requireEnv('B402_NETWORK') as `eip155:${number}`,
  recipient,
  onSettlementUnknown(event) {
    reportUnknownSettlement(event)
  },
})
const payments = Mppx.create({ methods: [b402Charge], secretKey })
const app = new Hono()

app.get('/api/b402/eip3009', async (context) => {
  const result = await payments.b402.charge({
    amount: priceDecimal,
    transferMethod: 'eip3009',
  })(context.req.raw)
  if (result.status === 402) return result.challenge
  return result.withReceipt(context.json(paidPayload('eip3009')))
})

app.get('/api/b402/permit2', async (context) => {
  const result = await payments.b402.charge({
    amount: priceDecimal,
    transferMethod: 'permit2-exact',
  })(context.req.raw)
  if (result.status === 402) return result.challenge
  return result.withReceipt(context.json(paidPayload('permit2-exact')))
})

function paidPayload(transferMethod: 'eip3009' | 'permit2-exact') {
  return {
    generatedAt: new Date().toISOString(),
    method: 'b402/charge',
    transferMethod,
    title: 'BNB Chain stablecoin market snapshot',
  }
}

function reportUnknownSettlement(event: B402SettlementUnknownEvent): void {
  // Hand this event to the merchant's existing order/reconciliation workflow.
  console.error(
    `[merchant] B402 settlement UNKNOWN for ${event.expectation.transferMethod}: ${event.reason}`,
  )
}

const port = Number.parseInt(process.env.PORT ?? '3001', 10)
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[merchant] listening on http://localhost:${info.port}`)
  console.log('[merchant] B402 routes: /api/b402/eip3009, /api/b402/permit2')
})
