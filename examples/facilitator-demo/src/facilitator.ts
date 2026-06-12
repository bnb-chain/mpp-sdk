/**
 * The FACILITATOR's gateway — onboard a merchant's existing API onto MPP
 * with zero merchant code changes.
 *
 * Architecture (mppx/proxy `Proxy.create` + this SDK's charge method):
 *
 *   payer ──► facilitator gateway (:3003) ──► merchant upstream (:3002)
 *               │  /acme-research/premium-report   GET /premium-report
 *               │
 *               ├─ no credential   → 402 + WWW-Authenticate challenge
 *               ├─ valid credential → verify (+ settle) → proxy upstream,
 *               │                     return content + Payment-Receipt
 *               └─ free routes (`true`) → plain passthrough
 *
 * Division of labor:
 *   - merchant: keeps running its API untouched; receives funds ON-CHAIN
 *     at its own address (`MERCHANT_RECIPIENT_ADDRESS`) — the facilitator
 *     never custodies the payment.
 *   - facilitator (this process): owns the MPP machinery — the challenge
 *     HMAC secret, the replay store, RPC access, and (optionally) the
 *     settlement signer that sponsors permit2 gas.
 *
 * Onboarding one more merchant = one more `custom(...)` service entry
 * (own upstream baseUrl, own recipient, own route prices) — see README.
 *
 * The gateway also auto-serves discovery endpoints for agents:
 *   GET /openapi.json   — generated OpenAPI doc of the paid routes
 *   GET /llms.txt       — machine-readable service + pricing summary
 *
 * Run:  pnpm --filter @bnb-chain/mpp-example-facilitator-demo start
 */

import { chargeFromDecimal } from '@bnb-chain/mpp'
import { chargeAsync } from '@bnb-chain/mpp/server'
import { serve } from '@hono/node-server'
import { Proxy, custom } from 'mppx/proxy'
import { Mppx } from 'mppx/server'
import { privateKeyToAccount } from 'viem/accounts'

// mppx/proxy matches routes with the URLPattern Web API, which Node ships
// natively only from 24 (mppx itself targets Node 24.5 in CI). This repo's
// runtime floor is Node >= 22, so polyfill when missing.
if (!('URLPattern' in globalThis)) await import('urlpattern-polyfill')

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing env var ${name} — copy .env.example to .env and fill it in`)
  return value
}

// The MERCHANT's payout address — settlement lands here directly.
const merchantRecipient = requireEnv('MERCHANT_RECIPIENT_ADDRESS') as `0x${string}`
// The facilitator's optional hot signer (sponsors permit2 settlement gas).
const settlementKey = process.env.SETTLEMENT_PRIVATE_KEY

const charge = await chargeAsync({
  chain: 'bsc-testnet',
  token: 'TEST_USDT',
  recipient: merchantRecipient,
  challengeBinding: { mode: 'mppx-managed' },
  ...(process.env.RPC_URL ? { rpcUrl: process.env.RPC_URL } : {}),
  ...(settlementKey
    ? { settlementAccount: privateKeyToAccount(toPrivateKey(settlementKey)) }
    : { credentialTypes: ['transaction', 'hash'] as const }),
  // Production: durable replay store (Redis/Postgres) — REQUIRED. The
  // facilitator runs ONE store across all its merchants/pods (draft §9).
})

// The facilitator owns the mppx handler (challenge binding secret included).
const mppx = Mppx.create({ methods: [charge], secretKey: requireEnv('MPP_SECRET_KEY') })

// 1 TEST_USDT per call (18 decimals → base units).
const PRICE = chargeFromDecimal({ amount: '1', decimals: 18 }).amount

const upstreamUrl = process.env.UPSTREAM_URL ?? 'http://localhost:3002'

const proxy = Proxy.create({
  title: 'Demo MPP Facilitator',
  description: 'Pay-per-request gateway in front of merchant APIs (BSC Testnet, TEST_USDT).',
  services: [
    // One entry per onboarded merchant. Mounted at /{id}/... on this host.
    custom('acme-research', {
      baseUrl: upstreamUrl,
      title: 'Acme Research (merchant)',
      description: 'Weekly on-chain stablecoin research, 1 TEST_USDT per report.',
      routes: {
        // Paid: the SDK issues/verifies the 402 challenge, settles, then
        // the proxy forwards upstream and attaches the Payment-Receipt.
        'GET /premium-report': mppx.evm.charge({ amount: PRICE }),
        // Free passthrough.
        'GET /health': true,
      },
    }),
  ],
})

function toPrivateKey(value: string): `0x${string}` {
  return (value.startsWith('0x') ? value : `0x${value}`) as `0x${string}`
}

const port = Number.parseInt(process.env.PORT ?? '3003', 10)
serve({ fetch: proxy.fetch, port }, (info) => {
  const base = `http://localhost:${info.port}`
  console.log(`[facilitator] gateway on ${base} → upstream ${upstreamUrl}`)
  console.log(`[facilitator] merchant payout: ${merchantRecipient}`)
  console.log(
    `[facilitator] credentials: ${settlementKey ? 'permit2, transaction, hash (sponsored settlement on)' : 'transaction, hash (payer-funded)'}`,
  )
  console.log(`[facilitator] paid route:  GET ${base}/acme-research/premium-report (1 TEST_USDT)`)
  console.log(`[facilitator] free route:  GET ${base}/acme-research/health`)
  console.log(`[facilitator] discovery:   GET ${base}/openapi.json · GET ${base}/llms.txt`)
})
