# charge-server example

Minimal Hono HTTP server demoing `@bnb-chain/mpp/server`. Several protected
routes gate content behind a USDT payment on **BSC Testnet (chainId 97)** (see
[Routes](#routes)); the default `/api/article` accepts the three credential
types the token supports — `permit2`, `transaction`, `hash`. (The token is
PancakeSwap's test USDT, a plain BEP-20 with no EIP-3009, so there is no
`authorization` path.)

Because `permit2` settles server-side (the server broadcasts
`permitWitnessTransferFrom`), this example **requires a server-side
settlement signer** (`SETTLEMENT_PRIVATE_KEY`). That signer must hold tBNB
(BSC Testnet) for gas.

## Run

```bash
cd examples/charge-server
cp .env.example .env
# Edit .env:
#   RECIPIENT_ADDRESS       merchant address that receives the USDT (REQUIRED)
#   MPP_SECRET_KEY          `openssl rand -hex 32` — HMAC challenge-binding key (REQUIRED)
#   SETTLEMENT_PRIVATE_KEY  0x + 64 hex (or bare 64 hex) — server signer that
#                           broadcasts permit2 settlement (REQUIRED).
#                           MUST hold tBNB for gas.
#   RPC_URL                 optional BSC Testnet RPC; defaults to the public data-seed endpoint
#   PORT                    optional, default 3000
pnpm --filter @bnb-chain/mpp-example-charge-server start
```

`start` runs three things:

1. **`prestart`** — `pnpm -C ../.. build` rebuilds the SDK `dist/` from
   the repo root (the workspace dep resolves to the built output; `dist/`
   is gitignored so a fresh clone needs this once). `pnpm --filter
@bnb-chain/mpp build` would silently no-op from inside this workspace,
   so the hook uses `-C ../..` to jump to the repo root.
2. **`node --env-file-if-exists=.env`** — Node 22+ loads `.env` natively.
3. **`--import tsx`** — runs `src/index.ts` directly, no separate TS build.
   tsx is used rather than Node's bare `--experimental-strip-types` because
   `index.ts` imports `./config.js` etc. (the NodeNext convention) which
   resolve to `.ts` files — Node's native type-stripping does not rewrite
   those specifiers, but tsx does.

`src/index.ts` validates `RECIPIENT_ADDRESS` (hex shape + non-zero) and
`SETTLEMENT_PRIVATE_KEY` (64 hex, 0x optional) at startup, with distinct
error messages per failure mode, before binding the port. On boot it
prints the chain / token / credential set / recipient / settlement
address.

## Routes

| Route                        | What it shows                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `GET /api/article`           | Fixed 1 USDT — the canonical happy path.                                                          |
| `GET /api/download?order=ID` | Fixed 1 USDT + `externalId` bound into the receipt (order reconciliation).                        |
| `GET /api/tip?amount=2.50`   | Dynamic amount, server-validated to 0.10–100 USDT (missing / out-of-range / non-numeric → 400).   |
| `GET /api/split`             | 1 USDT settled as a 2-entry Permit2 batch — merchant + a configured platform fee.                 |
| `GET /api/hash-only`         | Payer-funded: advertises only `transaction` / `hash`, runs with NO settlement signer.             |
| `GET /api/stored/article`    | Stored-lookup challenge binding (§8.0.1) — HMAC-free; the server remembers each issued challenge. |

`split`, `hash-only`, and `stored` use their own handler configs
(`createHandlers` in `src/handler.ts`): the route-override guard (spec §10)
only lets `amount` / `description` / `externalId` vary per route, so
`credentialTypes` / `splits` / `challengeBinding` are fixed at factory-config
time. `stored` uses `challengeBinding: { mode: 'stored-lookup', challengeStore }`
and persists each issued challenge with `rememberChallenge` (wired via
`onChallengeCreated`). It's the draft §6 zero-deviation path: its handler is
created **without a `secretKey`** — no mppx HMAC layer, the challenge store is
the sole binding, so a forged / tampered id simply isn't in the store. (Pass a
`secretKey` as well to get HMAC + stored-lookup defense-in-depth instead.)

## The `permit2Spender` wire field

When this server issues a `402`, the challenge's `methodDetails` includes
`permit2Spender` — the settlement signer's address. Permit2 hashes
`msg.sender` (the eventual on-chain caller) as the EIP-712 `spender`, so
the client MUST sign Permit2 typed data with this address or settlement
reverts `InvalidSigner`. The SDK injects it automatically from
`settlementAccount.address`; see `docs/spec-compliance.md` and
`docs/adr/0001-permit2-spender.md`.

## Test the 402 challenge phase

```bash
curl -v http://localhost:3000/api/article
```

```
HTTP/1.1 402 Payment Required
WWW-Authenticate: Payment id="..."; realm="..."; method="evm"; intent="charge"; request="..."; ...
```

The base64url `request` decodes to the wire challenge — `chainId`
97, `credentialTypes` `["permit2","transaction","hash"]`,
`permit2Address`, `permit2Spender`, `decimals` (18), `recipient`.

## Test the settlement phase

Build a credential client-side from `@bnb-chain/mpp/client` and re-hit
the route. `hash` is the simplest (you broadcast the USDT transfer
yourself first):

```ts
import { Challenge } from 'mppx'
import { createHashCredential } from '@bnb-chain/mpp/client'

// 1. Get the 402 challenge.
const res = await fetch('http://localhost:3000/api/article')
const challenge = Challenge.deserialize(res.headers.get('WWW-Authenticate')!)

// 2. Build a hash credential referencing your on-chain settlement tx
//    (recipient / currency / amount MUST match the challenge.request).
const credential = await createHashCredential({
  challenge,
  hash: '0x...your txHash...',
})

// 3. Re-hit with the credential. Credential.serialize already returns the
//    COMPLETE `Payment ...` Authorization header value — use as-is.
const paid = await fetch('http://localhost:3000/api/article', {
  headers: { Authorization: credential },
})
console.log(paid.status) // 200
console.log(paid.headers.get('Payment-Receipt'))
```

For `permit2`, use `createPermit2Credential`; it signs EIP-712 typed data
and the server settles on-chain. The browser demo (`examples/charge-demo`)
drives `hash` + `permit2` end-to-end against this server.

## Configuration knobs in `src/handler.ts`

- `credentialTypes` — defaults to the matrix set for bsc-testnet/TEST_USDT
  (`["permit2","transaction","hash"]` — no EIP-3009, so no `authorization`).
  Restrict it to `["transaction","hash"]` to run **without** a settlement
  signer (those two don't settle server-side).
- `chain` / `token` — `bsc-testnet` / `TEST_USDT`. Swap to another curated
  `(chain, token)` pair from `src/server/curated.ts`.
- `challengeBinding` — `mppx-managed` here.

## Production replay store

`preflightCharge` defaults to `Store.memory()` — in-process only, lost on
restart, not shared across instances. The replay store is the double-spend
guard (draft §9), so production MUST back it with a durable atomic store.
Under `NODE_ENV=production`, omitting `params.store` THROWS at startup, so you
can't accidentally ship the memory store.

[`src/redisStore.ts`](src/redisStore.ts) is a minimal Redis-backed
`ChargeStore`. It hands mppx's `Store.redis()` an atomic **Lua compare-and-set**
(`EVAL`) `update` — atomicity is the caller's job, because a bare `get` then
`set` is the TOCTOU double-spend window draft §9.3 forbids. (A Lua script,
not `WATCH`/`MULTI`: `WATCH` state is connection-scoped, so concurrent
`update()` calls sharing one connection would corrupt each other.) Wire it in
`handler.ts`:

```ts
import Redis from 'ioredis'
import { createRedisChargeStore } from './redisStore.js'

const store = createRedisChargeStore(new Redis(process.env.REDIS_URL!))
await chargeAsync({ chain: 'bsc-testnet', token: 'TEST_USDT', recipient, store /* … */ })
```

mppx also ships `Store.upstash` (Vercel KV) and `Store.cloudflare` (KV). See
`docs/replay-store.md` for the full 3-state (inflight / consumed / rejected)
model the store backs.

## Hardening (fee-payer protection)

`permit2` settles server-side — the server pays gas — so a
fee-paying deployment needs the draft §10.6 guards. `src/hardening.ts` ships
illustrative (in-memory, single-instance) skeletons, wired in `index.ts`:

- **Rate limit** — per-IP throttle on `/api/*` (429 over the limit). Tune with
  `RATE_LIMIT_MAX` (default 60/min).
- **Gas guard** — watches the settlement signer's native balance + an hourly
  gas budget (`GasGuard.snapshot()` / `recordSpend()`).
- **Dynamic credential gating** — `/api/article` calls `pickHandlerForGas`:
  when the signer is low / over budget it serves the **payer-funded** handler
  (`transaction` / `hash` only) instead of the sponsored one, so an empty
  signer can't be griefed into failed sponsored settlements. No SDK change —
  `credentialTypes` is fixed at factory-config, so this just picks between two
  pre-built handlers.

A production deployment swaps the in-memory limiter/budget for a shared store
(Redis), records real settlement gas (`gasUsed * effectiveGasPrice`), and adds
client authentication + a payer balance pre-check.

## What this example does NOT show

- **A real merchant treasury.** `RECIPIENT_ADDRESS` is whatever you set;
  the example doesn't open a wallet for you.
- **A private RPC.** Defaults to the public BSC Testnet data-seed endpoint;
  pin your own (NodeReal / QuickNode) for real traffic via `RPC_URL`.
