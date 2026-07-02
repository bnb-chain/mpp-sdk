# server — add MPP to an existing API

**Audience: merchants.** You have an API; you want each request paid in
stablecoins. This demo is the smallest honest version of that journey:

- [`src/server-plain.ts`](src/server-plain.ts) — your API **before**: one
  ordinary JSON endpoint, no payments.
- [`src/server.ts`](src/server.ts) — the same endpoint **after**: charges
  per request via the
  [`draft-evm-charge-00`](https://paymentauth.org/draft-evm-charge-00.html)
  `402 Payment Required` flow.

Funds settle on-chain **directly to your address** — no intermediary
custody. Out of the box the server is **payer-funded** (mode 1): it holds
**no private key** and spends **no gas** (it only verifies the payer's
transfer). That is the whole quickstart — two env vars and go. The other
settlement modes (local permit2 signer, b402, the x402 route) are
[Advanced flows](#advanced-flows); buyers are unaffected either way (they
always speak the same mppx wire).

## The entire diff

Boot-time setup (once per process):

```ts
import { Mppx } from 'mppx/server'
import { chargeFromDecimal } from '@bnb-chain/mpp'
import { chargeAsync } from '@bnb-chain/mpp/server'

const charge = await chargeAsync({
  chain: 'bsc-testnet', // or 'bsc', 'ethereum', 'base', ...
  token: 'TEST_USDT', // or 'FDUSD', 'USDC', ...
  recipient: env.RECIPIENT_ADDRESS, // you get paid here
  challengeBinding: { mode: 'mppx-managed' },
  credentialTypes: ['transaction', 'hash'], // payer-funded — no server key
})
const handler = Mppx.create({ methods: [charge], secretKey: env.MPP_SECRET_KEY })
const PRICE = chargeFromDecimal({ amount: '1', decimals: 18 }).amount
```

And inside the route handler:

```diff
 app.get('/api/premium', async (c) => {
+  const result = await handler.evm.charge({ amount: PRICE })(c.req.raw)
+  if (result.status === 402) return result.challenge
-  return c.json({ ... })
+  return result.withReceipt(c.json({ ... }))
 })
```

That's the whole integration: no credential → the SDK answers `402` with
a `WWW-Authenticate: Payment ...` challenge; a valid credential → the SDK
verifies the on-chain transfer and your unchanged response goes out with
a `Payment-Receipt` header (the settlement tx hash, draft §7.6).

## Run it

Prereqs: Node ≥ 22, `corepack enable`, then `pnpm install` at the repo
root.

All commands run from the **repo root**:

```bash
# LEVEL 0: exactly two values
cp examples/server/.env.example examples/server/.env
#   edit it: RECIPIENT_ADDRESS=<your address>, MPP_SECRET_KEY=<openssl rand -hex 32>

# the "before" server (no payments)
pnpm --filter @bnb-chain/mpp-example-server start:plain

# the "after" server (402-gated, :3001)
pnpm --filter @bnb-chain/mpp-example-server start
```

`.env.example` is organized in **levels** — LEVEL 0 (the two vars above) is
the whole quickstart; each later level unlocks one Advanced flow (modes 2/3,
then the x402 route). The boot banner prints what's active.

Probe the challenge phase:

```bash
curl -i http://localhost:3001/api/premium
# HTTP/1.1 402 Payment Required
# WWW-Authenticate: Payment id="…", method="evm", intent="charge", request="<base64url>", …
```

Then pay it for real with the browser client ([`examples/client`](../client)):

```bash
pnpm --filter @bnb-chain/mpp-example-client dev   # → http://localhost:5173
```

Connect MetaMask (BSC Testnet) and hit **Run All** on the **Hash** tab — its
vite proxy targets this server on :3001 out of the box. That completes the
golden path; everything below is opt-in.

## Route map — which path each resource takes

The server exposes **two paid resources**. `/api/premium` is ONE route whose
accepted credentials and settlement path are swapped by the active mode (the
boot banner prints the live shape); `/x402/premium` is a separate route on a
different wire entirely. (`start:plain` serves the unpaid "before" version of
`/api/premium`.)

| Resource                    | Wire (402 shape)                                                             | Accepts                                                    | Broadcast + gas paid by                                                              | Enabled by                                 | Paying client tab                    |
| --------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------ | ------------------------------------ |
| `GET /api/premium` (mode 1) | mppx charge — `WWW-Authenticate: Payment` header ⇄ `Authorization: Payment`  | `transaction` · `hash` (TEST_USDT)                         | the **payer's wallet**                                                               | LEVEL 0 (default)                          | **Hash** — BSC Testnet (USDT) preset |
| `GET /api/premium` (mode 2) | same mppx wire                                                               | mode 1 + `permit2` (TEST_USDT)                             | payer for `transaction`/`hash`; **your `SETTLEMENT_PRIVATE_KEY` signer** for permit2 | LEVEL 1                                    | **Hash** / **Permit2** — same preset |
| `GET /api/premium` (mode 3) | same mppx wire (buyers unaffected)                                           | `authorization` (EIP-3009, `$U`) ONLY — replaces modes 1/2 | the **b402 facilitator**                                                             | LEVEL 2 (`B402_*` + explicit `B402_CHAIN`) | **Authorization** — $U presets       |
| `GET /x402/premium`         | standalone x402 — JSON 402 body ⇄ `X-PAYMENT` / `X-PAYMENT-RESPONSE` headers | b402 `permit2-exact`                                       | the **b402 spender contract**                                                        | LEVEL 3 (`X402_TOKEN_*`, needs mode 3)     | **x402 · Permit2** — any preset      |

Client-side pairing needs no config for any of these — the client's proxy
already targets both wires on :3001, and each tab knows its endpoint (see
[the client's Configuration section](../client/README.md#configuration--what-the-client-calls)).

## Advanced flows

Each flow below is one more block in [.env.example](.env.example) (LEVEL
1/2/3). Enable them one at a time — the boot banner confirms what's active.

### Mode 2 — server-sponsored `permit2` (LEVEL 1)

Set `SETTLEMENT_PRIVATE_KEY` in `.env` and the server additionally
advertises `permit2`: the payer only signs typed data (no gas), and your
server broadcasts the settlement (`permitWitnessTransferFrom`) — the
signer account pays gas, so fund it with tBNB. This is the better payer
UX at the cost of operating a hot signer (see the hardening notes in the
production checklist of [`docs/quickstart.md`](../../docs/quickstart.md)
before doing this in production).

### Mode 3 — b402-settled EIP-3009 `$U` (LEVEL 2) ⚠️

Set the `B402_*` vars **plus an explicit `B402_CHAIN`** in `.env` and the
server switches to **mode 3**: it charges **`$U`** and accepts the EIP-3009
**`authorization`** credential, settling it through the Binance **b402**
facilitator via a `settleBackend` adapter.

> **Chain choice is forced, not defaulted.** `B402_CHAIN=bsc` (mainnet,
> ⚠️ REAL FUNDS) is the verified-working eip3009 path.
> `B402_CHAIN=bsc-testnet` is currently **NOT a runnable authorization
> path** — the facilitator's testnet eip3009 kind advertises a domain name
> (`"U"`) matching no known testnet `$U` contract, so settles fail
> ([ADR-0004](../../docs/adr/0004-b402-permit2.md) open question 2); the
> server refuses to boot without an explicit choice and warns loudly on
> testnet. (The LEVEL 3 x402 route below DOES work on testnet.) b402 broadcasts
> `transferWithAuthorization` and pays gas, so the server holds **no signer**
> and the buyer pays **no gas** — they only sign. The `B402_*` credentials
> come from Binance OnchainPay merchant onboarding (no self-serve signup),
> and buyers on this path must hold `$U` on the mode-3 chain — no faucet; see
> [`docs/b402.md`](../../docs/b402.md).

```bash
# .env additions for mode 3 / LEVEL 2 (alongside RECIPIENT_ADDRESS + MPP_SECRET_KEY):
B402_CHAIN=bsc               # REQUIRED — see the note above (⚠️ bsc = real funds)
B402_BASE_URL=https://cb.binanceapi.com   # mainnet facilitator
B402_CLIENT_ID=...
B402_ACCESS_TOKEN=...
B402_PRIVATE_KEY=...         # the RSA signing key b402 issued you — Base64 PKCS#8 DER,
                              # a Base64-wrapped PEM, or a raw PEM (NOT a 0x EVM private key)
PRICE_DECIMAL=0.01           # keep the per-request price small on mainnet

pnpm --filter @bnb-chain/mpp-example-server start
# [merchant] settlement: b402 settle (authorization, bsc/$U — facilitator pays gas) ⚠️ MAINNET — REAL FUNDS
```

`RECIPIENT_ADDRESS` **MUST** be your **registered b402 payout** address —
b402 settles to it. An unregistered payout does not fail at boot: it
surfaces at the **first paid request**, as a b402 `/settle` `errorReason`
the buyer sees as a 402 verification-failed carrying that reason. Pay it
from the browser client's **Authorization** tab (select a `$U` chain preset,
connect a wallet holding `$U`, Run All — the wallet only signs; this server
settles through b402). The only line that differs from modes 1/2 is `settleBackend` —
see [`docs/adr/0002`](../../docs/adr/0002-settle-adapter.md); full trust
model + wire details in [`docs/b402.md`](../../docs/b402.md).

Mainnet specifics: the curated `$U` is
`0xcE24439F2D9C6a2289F741120FE202248B666666` (domain `United Stables`/`1`,
verified on-chain); `RECIPIENT_ADDRESS` must be your **mainnet-registered**
payout; the payer wallet must hold mainnet `$U` (no gas needed — b402
broadcasts). The top-level `RPC_URL` (a testnet endpoint) is deliberately NOT
applied to a mainnet mode-3 boot; set `B402_RPC_URL` to pin a mainnet RPC.

### x402 route — b402 `permit2-exact` (LEVEL 3, needs mode 3)

Set `X402_TOKEN_ADDRESS` + `X402_TOKEN_NAME` (see `.env.example`) and the
server ALSO serves `/x402/premium` on the **pure x402 wire** — JSON 402 body
with `accepts[]`, `X-PAYMENT` in, `X-PAYMENT-RESPONSE` out. The whole
merchant recipe is ONE SDK call — `createX402Gate` from
`@bnb-chain/mpp/b402/server` — which resolves the b402 **permit2-exact** kind
fresh from `/supported` at boot (echoing its `extra`, spender included,
verbatim), gates incoming `X-PAYMENT`s with the full-shape validator, pins the
buyer-echoed offer against its own requirements, then runs `/verify` +
`/settle` and attaches `X-PAYMENT-RESPONSE`; the route handler in `server.ts`
only adds the content. `X402_TOKEN_NAME` must equal the kind's `extra.name`
(the token's EIP-712 domain name, not its symbol). Pay it with:

the browser client's **x402 · Permit2** tab (it fetches this route's 402
JSON, sends the one-time `approve(Permit2, max)` when needed, signs, and pays
with the `X-PAYMENT` header).

Same price as `/api/premium`; buyer-side details (one-time Permit2 approve,
the curated `trustedSpenders` allowlist) in
[the client's README](../client/README.md) and
[`docs/adr/0004`](../../docs/adr/0004-b402-permit2.md).

## Going to production

- Swap the curated pair: `chain: 'bsc', token: 'FDUSD'` (or `'U'`,
  `'BINANCE_PEG_USDT'`, `ethereum`/`USDC`, ...) — two strings.
- Pass a **durable replay store** (`store: ...`, Redis/Postgres) —
  in-memory is dev-only, and production startup throws without one. See
  [`docs/replay-store.md`](../../docs/replay-store.md).
- Pin your own `rpcUrl`; rate-limit the route; see the production
  checklist (incl. the hardening patterns: per-caller rate-limit, a gas
  budget on the settlement signer, degrade-to-payer-funded) in
  [`docs/quickstart.md`](../../docs/quickstart.md).
