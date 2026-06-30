/**
 * AFTER — the same API as `server-plain.ts`, now charging per request via MPP.
 * Every addition is fenced with `── MPP ──` markers.
 *
 * Three settlement modes, selected by env (buyers are UNAFFECTED in all three —
 * they always speak the same mppx wire):
 *
 *   1. payer-funded (default) — bsc-testnet / TEST_USDT, `transaction` / `hash`
 *      only. No server key, no gas.
 *   2. local permit2 settle — set SETTLEMENT_PRIVATE_KEY. The server's signer
 *      broadcasts `permitWitnessTransferFrom` and pays gas.
 *   3. b402 settle — set the B402_* vars. The EIP-3009 `authorization` credential
 *      is settled by the Binance b402 facilitator via a `settleBackend` adapter
 *      (no local signer; b402 pays gas). Runs on bsc-testnet / $U (eip155:97,
 *      no real funds). The settle-step `settleBackend` is the ONLY line that
 *      differs from mode 1/2 — see docs/adr/0002.
 *
 * Env (see .env.example): RECIPIENT_ADDRESS + MPP_SECRET_KEY required.
 *
 * Run:  pnpm --filter @bnb-chain/mpp-example-merchant-demo start
 * Try:  curl -i http://localhost:3001/api/premium   # → 402 + challenge
 *       then pay it with examples/client-demo (or examples/charge-demo in a wallet).
 */

import { chargeFromDecimal } from '@bnb-chain/mpp'
import { B402Adapter } from '@bnb-chain/mpp/b402/mppx'
import { B402Client } from '@bnb-chain/mpp/b402/server'
// ── MPP: imports ────────────────────────────────────────────────────────
import { chargeAsync, type ServerParameters } from '@bnb-chain/mpp/server'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { Mppx } from 'mppx/server'
import { privateKeyToAccount } from 'viem/accounts'

// ── MPP: one-time setup at boot ─────────────────────────────────────────
function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing env var ${name} — copy .env.example to .env and fill it in`)
  return value
}
function toPrivateKey(value: string): `0x${string}` {
  return (value.startsWith('0x') ? value : `0x${value}`) as `0x${string}`
}

const recipient = requireEnv('RECIPIENT_ADDRESS') as `0x${string}`
const settlementKey = process.env.SETTLEMENT_PRIVATE_KEY
const b402PrivateKey = process.env.B402_PRIVATE_KEY ?? process.env.B402_PRIVATE_KEY_B64
const useB402 = Boolean(
  process.env.B402_BASE_URL &&
  process.env.B402_CLIENT_ID &&
  process.env.B402_ACCESS_TOKEN &&
  b402PrivateKey,
)

const params: ServerParameters = useB402
  ? {
      // Mode 3 — settle the EIP-3009 authorization via b402 on BSC TESTNET
      // ($U, eip155:97, no real funds). `recipient` MUST be your registered b402
      // payout. The ONLY mode-specific line is settleBackend.
      chain: 'bsc-testnet',
      token: 'U',
      recipient,
      challengeBinding: { mode: 'mppx-managed' },
      credentialTypes: ['authorization'],
      settleBackend: new B402Adapter(
        new B402Client({
          baseUrl: requireEnv('B402_BASE_URL'),
          clientId: requireEnv('B402_CLIENT_ID'),
          accessToken: requireEnv('B402_ACCESS_TOKEN'),
          privateKey: b402PrivateKey as string,
        }),
        {
          // Opt-in b402 "Bazaar" discovery metadata for /api/premium. Persisted
          // by b402 for the upcoming public registry; an invalid blob is skipped
          // and never fails a settle, so it's safe to ship now.
          bazaar: {
            info: {
              input: { type: 'http', method: 'GET', path: '/api/premium' },
              output: { type: 'json', example: { title: 'BNB Chain stablecoin market snapshot' } },
            },
            schema: {
              $schema: 'https://json-schema.org/draft/2020-12/schema',
              type: 'object',
              properties: { input: { type: 'object' } },
              required: ['input'],
            },
            description: 'BNB Chain stablecoin market snapshot (premium)',
          },
        },
      ),
      ...(process.env.RPC_URL ? { rpcUrl: process.env.RPC_URL } : {}),
    }
  : {
      // Modes 1/2 — bsc-testnet / TEST_USDT (a plain BEP-20, no EIP-3009).
      chain: 'bsc-testnet',
      token: 'TEST_USDT',
      recipient,
      challengeBinding: { mode: 'mppx-managed' },
      ...(process.env.RPC_URL ? { rpcUrl: process.env.RPC_URL } : {}),
      ...(settlementKey
        ? { settlementAccount: privateKeyToAccount(toPrivateKey(settlementKey)) }
        : { credentialTypes: ['transaction', 'hash'] as const }),
    }

const charge = await chargeAsync(params)
const handler = Mppx.create({ methods: [charge], secretKey: requireEnv('MPP_SECRET_KEY') })

// Both $U and TEST_USDT are 18 decimals (all paths are BSC testnet, no real funds).
const PRICE = chargeFromDecimal({ amount: '1', decimals: 18 }).amount
// ── MPP: end setup ──────────────────────────────────────────────────────

const app = new Hono()

app.get('/api/premium', async (c) => {
  // ── MPP: gate the route ─────────────────────────────────────────────
  const result = await handler.evm.charge({ amount: PRICE })(c.req.raw)
  if (result.status === 402) return result.challenge // sends WWW-Authenticate
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
  const mode = useB402
    ? 'b402 settle (authorization, bsc-testnet/$U — facilitator pays gas)'
    : settlementKey
      ? 'local permit2 settle (bsc-testnet/TEST_USDT)'
      : 'payer-funded (transaction, hash — no server key)'
  console.log(`[merchant] listening on http://localhost:${info.port}`)
  console.log(`[merchant] settlement: ${mode}`)
  console.log(`[merchant] try: curl -i http://localhost:${info.port}/api/premium`)
})
