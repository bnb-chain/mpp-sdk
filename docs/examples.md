# Examples

Runnable examples under `examples/`, in two tiers.

## Start here — minimal merchant + buyer

Two minimal demos that compose: the client demo pays the merchant demo
(and the full `charge-server` below).

| Audience                   | Example                                      | What it shows                                                                                                                                                                                       |
| -------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Merchants**              | [`merchant-demo`](../examples/merchant-demo) | A plain API endpoint (`server-plain.ts`) and the same endpoint charging 1 TEST_USDT via MPP (`server.ts`) — the entire integration diff is ~10 lines. Payer-funded by default (no server-side key). |
| **API consumers / agents** | [`client-demo`](../examples/client-demo)     | Node CLI payer: fetch the 402, build a credential (`@bnb-chain/mpp/client`, all four types), retry with `Authorization`, decode the `Payment-Receipt`.                                              |

```bash
# terminal 1 — merchant (after `cp .env.example .env` in the example dir)
pnpm --filter @bnb-chain/mpp-example-merchant-demo start

# terminal 2 — pay it (PAYER_PRIVATE_KEY funded with tBNB + test USDT)
pnpm --filter @bnb-chain/mpp-example-client-demo start
```

### Buyer: `pay(url, { policy })` — one method, no rail in sight

The buyer expresses a payment INTENT, not a credential type; the SDK picks the
route (hard constraints filter, `mode` ranks). This is Phase 1 of the multi-rail
layer ([adr/0003](adr/0003-payment-offer-layer.md)) — mpp-only today.

```ts
import { pay } from '@bnb-chain/mpp/client'

const result = await pay('https://api.example/report', {
  wallet: { account, publicClient, walletClient }, // viem
  policy: {
    mode: 'prefer-gasless', // auto | prefer-gasless | require-gasless | prefer-direct | manual
    maxAmount: '1.00',
    allowedTokens: ['U'],
    allowApproval: true,
    allowPayerGas: false,
  },
  eip712Domains: { '97:0x180b…6a49': { name: 'United Stables', version: '1' } }, // for `authorization`
})
const data = await result.response.json() // result.route shows which method settled
```

No acceptable route → `NoAcceptableMethodError` (with per-route reasons), never a
stranded payment.

## b402 — Binance OnchainPay (x402)

Settle the EIP-3009 `authorization` credential through the **b402** x402 v2
facilitator (verify + settle hosted by Binance) instead of a local signer. The
buyer is unaffected — same mppx wire — only the merchant's settle step changes,
via `B402Adapter`. See [`docs/b402.md`](b402.md) for the full guide. No separate
example: the two existing demos carry it.

| Example                                      | What it shows for b402                                                                                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`merchant-demo`](../examples/merchant-demo) | **Mode 3** — set the `B402_*` env to settle `authorization` on `bsc-testnet`/`$U` via `B402Adapter` (b402 broadcasts + pays gas). `RECIPIENT_ADDRESS` must be your registered b402 payout. |
| [`charge-demo`](../examples/charge-demo)     | The b402 buyer: select **BSC Testnet ($U)** to switch to the EIP-3009 `authorization` path — connect MetaMask, sign `transferWithAuthorization` (no gas), submit.                          |

```bash
# server (fill examples/merchant-demo/.env with RECIPIENT_ADDRESS + MPP_SECRET_KEY
# + B402_BASE_URL / B402_CLIENT_ID / B402_ACCESS_TOKEN / B402_PRIVATE_KEY):
pnpm --filter @bnb-chain/mpp-example-merchant-demo start
# web wallet — point its endpoint at the merchant, then sign + submit:
pnpm --filter @bnb-chain/mpp-example-charge-demo dev
```

## Full examples

The production-shaped pair below runs **together** — the browser demo
drives real end-to-end flows against the local server.

| Example                                      | What it is                                                                                                                                                                                                                  |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`charge-server`](../examples/charge-server) | Minimal Hono HTTP server using `@bnb-chain/mpp/server`. Six protected routes (article / download / tip / split / hash-only / stored-lookup) + a public `/api/config`, BSC Testnet USDT, `permit2` / `transaction` / `hash`. |
| [`charge-demo`](../examples/charge-demo)     | React + shadcn/ui + wagmi browser app driving the full client flow against the server.                                                                                                                                      |

## Running both together

```bash
# Terminal 1 — server on :3000 (needs examples/charge-server/.env)
pnpm --filter @bnb-chain/mpp-example-charge-server start

# Terminal 2 — demo on :5173
pnpm --filter @bnb-chain/mpp-example-charge-demo dev
```

The demo's Vite dev server proxies `/api/*` → `http://localhost:3000`
(override with `VITE_CHARGE_SERVER_URL`), so the browser talks to the
server with no CORS setup. Both `start` / `dev` run a `prestart` /
`predev` hook (`pnpm -C ../.. build`) to rebuild the SDK `dist/` first.

## charge-server

Configured for `bsc-testnet` / `TEST_USDT`, accepting `permit2` /
`transaction` / `hash` (the token is a plain BEP-20, no EIP-3009, so no
`authorization`). Because `permit2` settles server-side, it requires
`SETTLEMENT_PRIVATE_KEY` (a hot signer holding tBNB for gas) alongside
`RECIPIENT_ADDRESS` + `MPP_SECRET_KEY`.

Its `402` advertises `permit2Spender` (the settlement signer's address)
in `methodDetails` — required so Permit2 clients sign with the right
EIP-712 `spender` (see [spec-compliance.md](spec-compliance.md)).

For a fully payer-funded path (no server gas), hit `/api/hash-only` — its
handler advertises only `['transaction', 'hash']` and carries no
settlement signer. The sponsored routes (`/api/article`, `/api/download`,
`/api/tip`) also auto-degrade to that payer-funded handler when the
settlement signer runs low on balance / over its hourly gas budget, while
`/api/split` and `/api/stored/article` return `503` (they have no
payer-funded equivalent). See the hardening notes in the README.

Full setup + the client-side settlement snippet:
[`examples/charge-server/README.md`](../examples/charge-server/README.md).

## charge-demo

A 4-step flow (Fetch challenge → Build credential → Local verify → Submit
& settle), per credential type, with each type's state kept in its own
pool. End-to-end mode (default) does the real server roundtrip; toggle it
off for local-only wire-shape inspection. Includes a Permit2 allowance
panel that handles the one-time `approve(Permit2, max)`.

The chain selector drives which credential tabs appear: **BSC Testnet
(USDT)** surfaces `hash` + `permit2` (on-chain settle), while **BSC Testnet
($U)** surfaces the EIP-3009 `authorization` path — the wallet signs
`transferWithAuthorization` (no gas, no buyer-side broadcast) for settlement
through [b402](b402.md) (pair it with `merchant-demo` mode 3).

Per-credential realism (what's on-chain vs in-page), faucet links, and
the source layout:
[`examples/charge-demo/README.md`](../examples/charge-demo/README.md).

## What you need on-chain (BSC Testnet)

The default flows run on `bsc-testnet` / `TEST_USDT` (a plain BEP-20, no
EIP-3009). The b402 path (merchant-demo mode 3 + charge-demo's `$U` tab)
adds the `authorization` credential on `bsc-testnet` / `$U`, where b402
sponsors gas — the buyer only signs, so it needs no payer funding. Funding
for the TEST_USDT paths:

- **hash** — the payer wallet broadcasts the transfer: needs tBNB (gas)
  \+ test USDT.
- **permit2** — payer needs test USDT + a one-time Permit2 approval
  (charge-demo's allowance panel or client-demo's auto-approve does it);
  the server's settlement signer needs tBNB for gas.
- **transaction** — the payer pre-signs an EIP-1559 transfer the server
  broadcasts; gas comes from the payer's balance. (In the browser
  charge-demo this signs with an in-page random key — MetaMask can't
  expose a pre-signed-unbroadcast RLP — so settlement intentionally fails
  at broadcast there; the Node client-demo signs with its own funded key
  and settles for real.)

Faucets: [BNB Chain testnet faucet](https://testnet.bnbchain.org/faucet-smart)
(tBNB); test USDT is PancakeSwap's BSC Testnet USDT at
[`0x337610…34dDd`](https://testnet.bscscan.com/token/0x337610d27c682E347C9cD60BD4b3b107C9d34dDd).
