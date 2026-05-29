/**
 * Minimal `@bnb-chain/mpp` server example — Sepolia USDC, all 4 credentials.
 *
 * Spin up a Hono HTTP server with several protected merchant routes
 * (article / download / tip / split / hash-only — see routes.ts). Hitting
 * any of them WITHOUT a valid Payment credential returns `402 Payment
 * Required` + a `WWW-Authenticate: Payment ...` challenge; WITH a valid
 * credential it settles and returns the content + a `Payment-Receipt`
 * header carrying the draft §7.6 receipt fields.
 *
 * Configured for **Ethereum Sepolia** + **Circle native USDC**, with all
 * four credential types enabled — `authorization` (EIP-3009),
 * `permit2`, `transaction`, `hash`. The first two require a server-side
 * settlement signer (the SDK calls `transferWithAuthorization` /
 * `permitWitnessTransferFrom` on-chain to actually move the funds), so
 * `SETTLEMENT_PRIVATE_KEY` is required.
 *
 * Configuration (env vars):
 *   RECIPIENT_ADDRESS         merchant address to receive funds (REQUIRED)
 *   MPP_SECRET_KEY            HMAC secret for mppx-managed challenge
 *                             binding (REQUIRED; `openssl rand -hex 32`)
 *   SETTLEMENT_PRIVATE_KEY    0x-prefixed 32-byte hex private key for the
 *                             server-side settlement signer. Required for
 *                             permit2 / authorization (which broadcast a
 *                             settlement tx). Must hold Sepolia ETH for gas.
 *   RPC_URL                   (optional) custom Sepolia RPC. Defaults to
 *                             viem's bundled public provider (rate-limited).
 *   PORT                      (optional) HTTP port, default 3000.
 *
 * Run:
 *   pnpm --filter @bnb-chain/mpp-example-charge-server start
 *
 * Test (challenge phase — no credential):
 *   curl -v http://localhost:3000/api/article
 *   # → 402 + WWW-Authenticate: Payment <serialized challenge>
 *   # methodDetails.credentialTypes will list all 4 in preference order:
 *   # ["authorization", "permit2", "transaction", "hash"]
 *
 * Test (settlement phase) — see README.md for the full
 * `Challenge.deserialize` + `createXxxCredential` client snippet,
 * OR use examples/charge-demo (browser UI) and point it at this server.
 */

import { serve } from '@hono/node-server'
import { createPublicClient, http, parseEther } from 'viem'
import { sepolia } from 'viem/chains'

import { loadConfig } from './config.js'
import { buildDeploymentConfig, createHandlers } from './handler.js'
import { GasGuard, rateLimit, recordSettlementGas } from './hardening.js'
import { createApp } from './routes.js'

const config = loadConfig()
const handlers = await createHandlers(config)
const deployment = await buildDeploymentConfig(config)

// Production-hardening skeletons (draft §10.6 fee-payer risks). In-memory +
// single-instance — illustrative only; a real deployment uses a shared store
// (Redis) for limits/budgets and tracks actual settlement gas.
const publicClient = createPublicClient({ chain: sepolia, transport: http(config.rpcUrl) })
const gasGuard = new GasGuard(publicClient, config.settlementAccount.address, {
  // Stop sponsoring settlement below ~0.005 ETH balance or past ~0.05 ETH/hour.
  minBalanceWei: parseEther('0.005'),
  hourlyBudgetWei: parseEther('0.05'),
})
const limiter = rateLimit({
  windowMs: 60_000,
  max: Number.parseInt(process.env.RATE_LIMIT_MAX ?? '60', 10),
})

// Track real sponsored-settlement gas against the hourly budget. Only
// permit2 / authorization cost the signer gas (transaction / hash are
// payer-funded), so filter by credential type before recording.
for (const h of [handlers.base, handlers.split, handlers.stored]) {
  h.onPaymentSuccess((ctx) => {
    const type = (ctx.credential?.payload as { type?: string } | undefined)?.type
    if (type === 'permit2' || type === 'authorization') {
      void recordSettlementGas(gasGuard, publicClient, ctx.receipt.reference)
    }
  })
}

const app = createApp(handlers, deployment, { rateLimit: limiter, gasGuard })

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`mpp-sdk charge-server listening on http://localhost:${info.port}`)
  console.log('  chain:           sepolia (chainId 11155111)')
  console.log('  token:           USDC (Circle native on Sepolia)')
  console.log('  credentials:     authorization, permit2, transaction, hash')
  console.log(`  recipient:       ${config.recipient}`)
  console.log(`  settlement addr: ${config.settlementAccount.address} (needs Sepolia ETH for gas)`)
  console.log(
    '  routes:          /api/article /api/download?order= /api/tip?amount= /api/split /api/hash-only /api/stored/article',
  )
  console.log(
    `  hardening:       rate-limit ${process.env.RATE_LIMIT_MAX ?? '60'}/min · gas floor 0.005 ETH · budget 0.05 ETH/hr`,
  )
  console.log(
    '  gas gating:      article/download/tip degrade to payer-funded · split/stored 503 when signer low',
  )
  console.log(`  try: curl -v http://localhost:${info.port}/api/article`)
})
