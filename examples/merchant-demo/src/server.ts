/**
 * AFTER — the same API as `server-plain.ts`, now charging 1 TEST_USDT
 * per request via MPP. Every addition is fenced with `── MPP ──` markers;
 * everything else is byte-identical to the "before" file.
 *
 * What the additions do:
 *
 *   1. boot-time: resolve the curated (chain, token) pair and create one
 *      mppx handler for the deployment (`chargeAsync` + `Mppx.create`).
 *   2. per-route: one call — `handler.evm.charge({ amount })(request)`.
 *      No credential → return the 402 challenge. Valid credential → the
 *      SDK verifies (and settles, for permit2) and you return your
 *      content wrapped in `withReceipt(...)`.
 *
 * Env (see .env.example): RECIPIENT_ADDRESS + MPP_SECRET_KEY required.
 * SETTLEMENT_PRIVATE_KEY is optional — without it the server runs fully
 * payer-funded (`transaction` / `hash` credentials only) and never holds
 * a private key; with it, `permit2` (server-sponsored settlement) is
 * advertised too.
 *
 * Run:  pnpm --filter @bnb-chain/mpp-example-merchant-demo start
 * Try:  curl -i http://localhost:3001/api/premium   # → 402 + challenge
 *       then pay it with examples/client-demo.
 */

import { chargeFromDecimal } from '@bnb-chain/mpp'
import { chargeAsync } from '@bnb-chain/mpp/server'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
// ── MPP: imports ────────────────────────────────────────────────────────
import { Mppx } from 'mppx/server'
import { privateKeyToAccount } from 'viem/accounts'

// ── MPP: one-time setup at boot ─────────────────────────────────────────
function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing env var ${name} — copy .env.example to .env and fill it in`)
  return value
}

const recipient = requireEnv('RECIPIENT_ADDRESS') as `0x${string}`
const settlementKey = process.env.SETTLEMENT_PRIVATE_KEY

const charge = await chargeAsync({
  // Curated testnet pair (PancakeSwap test USDT, 18 decimals). Swap to a
  // mainnet pair (e.g. chain: 'bsc', token: 'FDUSD') by changing two strings.
  chain: 'bsc-testnet',
  token: 'TEST_USDT',
  // Funds settle directly to this address — your address, not an intermediary.
  recipient,
  challengeBinding: { mode: 'mppx-managed' },
  ...(process.env.RPC_URL ? { rpcUrl: process.env.RPC_URL } : {}),
  ...(settlementKey
    ? // With a settlement signer the server can sponsor permit2 settlement
      // (it broadcasts `permitWitnessTransferFrom`; the signer pays gas).
      { settlementAccount: privateKeyToAccount(toPrivateKey(settlementKey)) }
    : // Without one, advertise only payer-funded credential types — the
      // payer broadcasts (or pre-signs) the transfer; this server never
      // touches a private key and never spends gas.
      { credentialTypes: ['transaction', 'hash'] as const }),
  // Production: pass a durable replay `store` (Redis/Postgres) — see
  // docs/quickstart.md "Production checklist". Dev default is in-memory.
})

const handler = Mppx.create({ methods: [charge], secretKey: requireEnv('MPP_SECRET_KEY') })

// 1 TEST_USDT (18 decimals) → base units ('1000000000000000000').
const PRICE = chargeFromDecimal({ amount: '1', decimals: 18 }).amount

function toPrivateKey(value: string): `0x${string}` {
  return (value.startsWith('0x') ? value : `0x${value}`) as `0x${string}`
}
// ── MPP: end setup ──────────────────────────────────────────────────────

const app = new Hono()

app.get('/api/premium', async (c) => {
  // ── MPP: gate the route ─────────────────────────────────────────────
  const result = await handler.evm.charge({ amount: PRICE })(c.req.raw)
  if (result.status === 402) return result.challenge // sends WWW-Authenticate
  // Paid + verified (+ settled). The original response below is unchanged,
  // just wrapped in withReceipt(...) to attach the Payment-Receipt header.
  // ── MPP: end gate ────────────────────────────────────────────────────
  return result.withReceipt(
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
})

const port = Number.parseInt(process.env.PORT ?? '3001', 10)
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[merchant] listening on http://localhost:${info.port}`)
  console.log(
    `[merchant] credentials: ${settlementKey ? 'permit2, transaction, hash' : 'transaction, hash (payer-funded — no server key)'}`,
  )
  console.log(`[merchant] try: curl -i http://localhost:${info.port}/api/premium`)
})
