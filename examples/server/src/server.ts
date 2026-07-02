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
 *      (no local signer; b402 pays gas). B402_CHAIN picks bsc-testnet or bsc
 *      (⚠️ mainnet = real funds). The settle-step `settleBackend` is the ONLY
 *      line that differs from mode 1/2 — see docs/adr/0002.
 *
 * Plus one OPTIONAL extra route (needs mode 3): set X402_TOKEN_ADDRESS +
 * X402_TOKEN_NAME and /x402/premium also serves the PURE x402 wire — b402
 * permit2-exact for tokens without a usable EIP-3009 door (docs/adr/0004).
 *
 * Env (see .env.example, organized in levels): RECIPIENT_ADDRESS +
 * MPP_SECRET_KEY required; everything else optional.
 *
 * Run:  pnpm --filter @bnb-chain/mpp-example-server start
 * Try:  curl -i http://localhost:3001/api/premium   # → 402 + challenge
 *       then pay it with examples/client (browser wallet, both wires).
 */

import { chargeFromDecimal } from '@bnb-chain/mpp'
import { b402ChargeParams } from '@bnb-chain/mpp/b402/mppx'
import { B402Client, createX402Gate } from '@bnb-chain/mpp/b402/server'
// ── MPP: imports ────────────────────────────────────────────────────────
import { chargeAsync, type ServerParameters } from '@bnb-chain/mpp/server'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { Mppx } from 'mppx/server'
import { privateKeyToAccount } from 'viem/accounts'

import './env.js'

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
// All-or-nothing: undefined when no B402_* var is set (run modes 1/2), a
// client when all four are, and a LOUD throw on a partial config — silently
// falling back to mode 1 would swap the token, credential type, and
// settlement semantics behind a typo'd variable name.
const b402Client = B402Client.fromEnv()
const useB402 = b402Client !== undefined

// Mode-3 chain — EXPLICIT, no default. 'bsc' (MAINNET — real funds; curated
// $U 0xcE24…6666, domain verified on-chain) is the verified-working eip3009
// path; on 'bsc-testnet' the facilitator's eip3009 kind advertises domain
// name "U", which matches no curated testnet token, so authorization settles
// CURRENTLY FAIL there (docs/adr/0004 OQ2 — the /x402 permit2 route is the
// working testnet path). Defaulting silently would boot a server whose settle
// step is known-broken; make the operator choose.
const b402Chain = process.env.B402_CHAIN as 'bsc' | 'bsc-testnet'
if (useB402 && b402Chain !== 'bsc' && (b402Chain as string) !== 'bsc-testnet') {
  throw new Error(
    `Mode 3 (b402) needs an explicit B402_CHAIN (got '${process.env.B402_CHAIN ?? ''}'). ` +
      `Set B402_CHAIN=bsc for the verified-working eip3009 path (⚠️ MAINNET — real funds), or ` +
      `B402_CHAIN=bsc-testnet knowing authorization settles currently fail there ` +
      `(facilitator domain-name mismatch, docs/adr/0004 open question 2; ` +
      `the /x402 permit2-exact route DOES work on testnet).`,
  )
}
if (useB402 && b402Chain === 'bsc-testnet') {
  console.warn(
    '[merchant] ⚠️ B402_CHAIN=bsc-testnet: the b402 testnet eip3009 kind mismatches every known ' +
      'testnet $U domain — authorization settles are expected to FAIL (docs/adr/0004 OQ2). ' +
      'The /x402 permit2-exact route is the working testnet path.',
  )
}
// RPC isolation: the top-level RPC_URL is a TESTNET endpoint in this demo's
// .env — applying it to a mainnet mode-3 boot would read the wrong chain.
// Mainnet uses B402_RPC_URL or the curated default.
const b402Rpc =
  process.env.B402_RPC_URL ?? (b402Chain === 'bsc-testnet' ? process.env.RPC_URL : undefined)

const params: ServerParameters = b402Client
  ? {
      // Mode 3 — settle the EIP-3009 authorization via b402 ($U). `recipient`
      // MUST be your b402 payout registered for THIS chain. b402ChargeParams
      // wires credentialTypes ['authorization'] + the B402Adapter settle
      // backend; buyers stay on the same mppx wire (docs/adr/0002).
      ...b402ChargeParams({
        client: b402Client,
        chain: b402Chain,
        recipient,
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
      }),
      ...(b402Rpc ? { rpcUrl: b402Rpc } : {}),
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

// Per-request price in HUMAN token units. Both $U and TEST_USDT are 18
// decimals. Default 1 token — on MAINNET (B402_CHAIN=bsc) that is REAL money;
// set PRICE_DECIMAL small (e.g. 0.01) for live testing.
const priceDecimal = process.env.PRICE_DECIMAL ?? '1'
const PRICE = chargeFromDecimal({ amount: priceDecimal, decimals: 18 }).amount
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

// ── Optional standalone x402 route (permit2-exact via b402) ─────────────
// Set X402_TOKEN_ADDRESS + X402_TOKEN_NAME in mode 3 to also serve
// /x402/premium on the pure x402 wire — the Permit2 path for tokens without a
// usable EIP-3009 door (docs/adr/0004-b402-permit2.md). Same price as
// /api/premium; the buyer pairing is the client's "x402 · Permit2" tab.
// createX402Gate does the whole merchant recipe (402 menu → X-PAYMENT
// validation → verify → settle → X-PAYMENT-RESPONSE); we only add content.
const x402Enabled = Boolean(b402Client && process.env.X402_TOKEN_ADDRESS)
if (b402Client && process.env.X402_TOKEN_ADDRESS) {
  const gate = await createX402Gate({
    client: b402Client,
    network: b402Chain === 'bsc' ? 'eip155:56' : 'eip155:97',
    asset: {
      address: process.env.X402_TOKEN_ADDRESS as `0x${string}`,
      // Must equal the b402 /supported kind's extra.name (the token's EIP-712
      // domain name, NOT its symbol) — createX402Gate throws at boot otherwise.
      name: requireEnv('X402_TOKEN_NAME'),
    },
    payTo: recipient,
    amount: PRICE,
    resource: {
      url: '/x402/premium',
      description: 'BNB Chain stablecoin market snapshot (premium, x402/permit2)',
      mimeType: 'application/json',
    },
  })
  app.get('/x402/premium', async (c) => {
    const result = await gate(c.req.raw)
    if (!result.paid) return result.response // 402 menu, or a 400/402 rejection
    return result.withPaymentResponse(
      c.json({
        title: 'BNB Chain stablecoin market snapshot (x402 / permit2-exact)',
        settledTx: result.settlement.transaction,
        generatedAt: new Date().toISOString(),
      }),
    )
  })
  console.log(
    `[merchant] x402 route: /x402/premium — permit2-exact ${process.env.X402_TOKEN_NAME} ` +
      `on ${gate.requirements.network} (spender ${gate.requirements.extra.spenderAddress})`,
  )
}

const port = Number.parseInt(process.env.PORT ?? '3001', 10)
serve({ fetch: app.fetch, port }, (info) => {
  const mode = useB402
    ? `b402 settle (authorization, ${b402Chain}/$U — facilitator pays gas)` +
      (b402Chain === 'bsc' ? ' ⚠️ MAINNET — REAL FUNDS' : '')
    : settlementKey
      ? 'local permit2 settle (bsc-testnet/TEST_USDT)'
      : 'payer-funded (transaction, hash — no server key)'
  console.log(`[merchant] listening on http://localhost:${info.port}`)
  console.log(`[merchant] settlement: ${mode} · price ${priceDecimal} token/request`)
  console.log(
    `[merchant] x402 route (/x402/premium, b402 permit2-exact): ${
      x402Enabled
        ? 'ENABLED'
        : 'off — set X402_TOKEN_ADDRESS + X402_TOKEN_NAME (needs mode 3), see .env.example LEVEL 3'
    }`,
  )
  console.log(`[merchant] try: curl -i http://localhost:${info.port}/api/premium`)
})
