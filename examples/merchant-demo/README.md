# merchant-demo — add MPP to an existing API

**Audience: merchants.** You have an API; you want each request paid in
stablecoins. This demo is the smallest honest version of that journey:

- [`src/server-plain.ts`](src/server-plain.ts) — your API **before**: one
  ordinary JSON endpoint, no payments.
- [`src/server.ts`](src/server.ts) — the same endpoint **after**: charges
  **1 TEST_USDT** (BSC Testnet) per request via the
  [`draft-evm-charge-00`](https://paymentauth.org/draft-evm-charge-00.html)
  `402 Payment Required` flow.

Funds settle on-chain **directly to your address** — no intermediary
custody. By default the server is _payer-funded_: it holds **no private
key** and spends **no gas** (it only verifies the payer's transfer).

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

```bash
cp .env.example .env   # fill in RECIPIENT_ADDRESS + MPP_SECRET_KEY

# the "before" server (no payments)
pnpm --filter @bnb-chain/mpp-example-merchant-demo start:plain

# the "after" server (402-gated)
pnpm --filter @bnb-chain/mpp-example-merchant-demo start
```

Probe the challenge phase:

```bash
curl -i http://localhost:3001/api/premium
# HTTP/1.1 402 Payment Required
# WWW-Authenticate: Payment id="…", method="evm", intent="charge", request="<base64url>", …
```

Then pay it for real with [`examples/client-demo`](../client-demo):

```bash
pnpm --filter @bnb-chain/mpp-example-client-demo start http://localhost:3001/api/premium
```

## Accepting server-sponsored payments too

Set `SETTLEMENT_PRIVATE_KEY` in `.env` and the server additionally
advertises `permit2`: the payer only signs typed data (no gas), and your
server broadcasts the settlement (`permitWitnessTransferFrom`) — the
signer account pays gas, so fund it with tBNB. This is the better payer
UX at the cost of operating a hot signer (see the hardening patterns in
[`examples/charge-server`](../charge-server) before doing this in
production).

## Going to production

- Swap the curated pair: `chain: 'bsc', token: 'FDUSD'` (or `'U'`,
  `'BINANCE_PEG_USDT'`, `ethereum`/`USDC`, ...) — two strings.
- Pass a **durable replay store** (`store: ...`, Redis/Postgres) —
  in-memory is dev-only, and production startup throws without one. See
  [`docs/replay-store.md`](../../docs/replay-store.md).
- Pin your own `rpcUrl`; rate-limit the route; see the production
  checklist in [`docs/quickstart.md`](../../docs/quickstart.md) and the
  hardened [`examples/charge-server`](../charge-server).
