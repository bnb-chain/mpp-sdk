# Examples

Exactly **two** runnable examples under `examples/` — a merchant and a buyer
— designed to run together:

| Side                | Example                        | What it is                                                                                                                                                                                                                                     |
| ------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Merchant**        | [`server`](../examples/server) | A plain API endpoint (`server-plain.ts`) and the same endpoint charging per request (`server.ts`) — the integration diff is ~10 lines. Three mppx settlement modes plus an optional standalone B402 Exact route (`eip3009` / `permit2-exact`). |
| **Buyer (browser)** | [`client`](../examples/client) | React + shadcn/ui + wagmi wallet app driving real end-to-end flows against the server, on BOTH wires: the mppx charge wire (`hash` / `permit2` / `authorization` tabs) and the standalone x402 wire (`x402 · Permit2` tab).                    |

## Running the pair

```bash
# Terminal 1 — server on :3001. The .env lives IN the example dir
# (LEVEL 0 needs only RECIPIENT_ADDRESS + MPP_SECRET_KEY):
cp examples/server/.env.example examples/server/.env   # then edit it
pnpm --filter @bnb-chain/mpp-example-server start

# Terminal 2 — browser client on :5173
pnpm --filter @bnb-chain/mpp-example-client dev
```

**First success = the Hash tab** (mode 1, payer-funded): connect MetaMask on
BSC Testnet and hit **⚡ Run All**. Every other tab / server level is an
advanced flow — enable them one at a time.

How the two sides pair, resource by resource:

| Server resource            | Wire                  | Server `.env` (LEVEL)             | Paying client tab (preset)                  | Client `.env`                                              |
| -------------------------- | --------------------- | --------------------------------- | ------------------------------------------- | ---------------------------------------------------------- |
| `/api/premium` (modes 1/2) | mppx charge           | LEVEL 0 (+ LEVEL 1 for `permit2`) | **Hash** / **Permit2** — BSC Testnet (USDT) | none — defaults pair                                       |
| `/api/premium` (mode 3)    | mppx charge           | LEVEL 2 (`B402_*` + `B402_CHAIN`) | **Authorization** — $U preset               | optional `VITE_DEFAULT_CHAIN_KEY` (or switch the dropdown) |
| `/x402/premium`            | standalone B402 Exact | LEVEL 3 (needs LEVEL 2)           | high-level B402 buyer or **x402 · Permit2** | optional `VITE_X402_ENDPOINT`                              |

The client's Vite dev server proxies `/api/*` and `/x402/*` →
`http://localhost:3001` (override with `VITE_CHARGE_SERVER_URL`), so the
browser talks to the server with no CORS setup. Both `start` / `dev` run a
`prestart` / `predev` hook (`pnpm -C ../.. build`) to rebuild the SDK `dist/`
first.

## server

Configuration is layered — `.env.example` is organized in **levels**, each
unlocking one more settlement capability (the boot banner tells you what's
active):

| Level | Env                                    | Unlocks                                                                                                                                                                                                                                                                                                                                        |
| ----- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | `RECIPIENT_ADDRESS` + `MPP_SECRET_KEY` | **Mode 1** — payer-funded `transaction` / `hash` on `bsc-testnet`/TEST_USDT. No server key, no server gas.                                                                                                                                                                                                                                     |
| 1     | + `SETTLEMENT_PRIVATE_KEY`             | **Mode 2** — also accept `permit2`: buyers sign only; the server broadcasts `permitWitnessTransferFrom` (signer pays gas).                                                                                                                                                                                                                     |
| 2     | + `B402_*` credentials + `B402_CHAIN`  | **Mode 3** — accept the EIP-3009 `authorization` credential ($U), settled by the [Binance b402](b402.md) facilitator (b402 broadcasts + pays gas). `B402_CHAIN` is REQUIRED: `bsc` ⚠️ = real funds and the only chain where authorization settles work today; on `bsc-testnet` they currently FAIL ([adr/0004](adr/0004-b402-permit2.md) OQ2). |
| 3     | + `X402_TOKEN_ADDRESS/X402_TOKEN_NAME` | `/x402/premium` — a second paid route on the native x402 wire: B402 Exact `eip3009` when supported plus `permit2-exact`, with a merchant-owned payment resolver, shared `/supported` cache, and explicit settlement-unknown hook.                                                                                                              |

Levels 0→1 stack, but **mode 3 replaces modes 1/2** on the mppx route: with
the `B402_*` credentials set, `/api/premium` charges `$U` and accepts only
`authorization` (the `hash`/`permit2` TEST_USDT paths are mode-1/2-only).
LEVEL 3 adds `/x402/premium` **alongside** mode 3.

Its `402` advertises `permit2Spender` (the settlement signer's address) in
`methodDetails` when mode 2 is on — required so Permit2 clients sign with the
right EIP-712 `spender` (see [spec-compliance.md](spec-compliance.md)).

Full walkthrough: [`examples/server/README.md`](../examples/server/README.md).

## client

A 4-step flow (fetch → build → local-verify → submit), per credential tab,
with each tab's state in its own pool. The chain preset + server capabilities
drive which tabs appear:

- **BSC Testnet (USDT)** — `hash` (real on-chain settle) + `permit2` (real
  wallet-signed EIP-712; settles when the server runs mode 2) +
  `x402 · Permit2`.
- **$U presets (testnet / ⚠️ mainnet)** — `authorization` (EIP-3009: the
  wallet only signs; a mode-3 server settles through b402 — ⚠️ settles work
  on **mainnet only** today; the testnet preset is a sign+submit wire demo,
  [adr/0004](adr/0004-b402-permit2.md) OQ2) + `x402 · Permit2`.
- **`x402 · Permit2`** (every preset) — the standalone x402 wire against
  `/x402/premium`: fetch the 402 JSON offer, one-time on-chain
  `approve(Permit2, max)` if needed (costs gas ⚠️), wallet-sign
  `PermitWitnessTransferFrom`, pay with the `X-PAYMENT` header. The SDK
  refuses to sign for any spender outside its curated b402 allowlist.

Per-tab realism callouts (what's on-chain vs in-page), faucet links, and the
source layout: [`examples/client/README.md`](../examples/client/README.md).

## Buyer as code: `pay(url, { policy })` — one method, no rail in sight

For headless/Node buyers, the SDK ships the high-level `pay()`: the buyer
expresses a payment INTENT, not a credential type; the SDK picks the route
(hard constraints filter, `mode` ranks). This is Phase 1 of the multi-rail
layer ([adr/0003](adr/0003-payment-offer-layer.md)) — mpp-only today.

```ts
import { pay } from '@bnb-chain/mpp/client'

const result = await pay('https://api.example/report', {
  wallet: { account, publicClient, walletClient }, // viem
  policy: {
    mode: 'prefer-gasless', // auto | prefer-gasless | require-gasless | prefer-direct | manual
    maxAmount: '1.00',
    allowedAssets: [{ chainId: 97, address: '0xc70b8741b8b07a6d61e54fd4b20f22fa648e5565' }], // (chainId, address) — the wire identity, not symbol
    allowedChains: [97], // numeric chainId
    allowApproval: true,
    allowPayerGas: false,
  },
  eip712Domains: {
    '97:0xc70b8741b8b07a6d61e54fd4b20f22fa648e5565': { name: 'United Stables', version: '1' },
  }, // for `authorization`
})
const data = await result.response.json() // result.route shows which method settled
```

The `eip712Domains` key's address part is matched case-insensitively.

Paying a non-GET resource (an API with a body / an app token / `Accept`)?
Pass `request` — it's reused on the probe and the paid retry, with
`Authorization` merged on top by `pay()`:
`pay(url, { wallet, policy, request: { method: 'POST', headers, body } })`.
The body must be replayable (it is sent twice) — a `ReadableStream` is
rejected. `request.headers` MUST NOT set `Authorization` — that header is
reserved for the payment credential; put app auth in `X-Api-Key` / `Cookie` /
a custom header instead (`pay()` rejects an `Authorization` header up front,
before any signing/broadcast).

It fails closed in every direction:

- no acceptable route → `NoAcceptableMethodError` (per-route reasons; nothing
  signed or sent);
- the server rejects the retry (non-2xx) → `PaymentRejectedError` — carries
  `credential` (the exact built value, already broadcast for `hash` /
  `transaction`);
- a failure AFTER an irreversible step — a broadcast, or a retry `fetch` that
  threw / timed out — → `PaymentSideEffectError`, carrying whatever exists to
  reconcile (`credential` / `txHash` / `approveTxHash` / `cause`).

The last two mean the payment may already be in flight: reconcile on-chain and
resubmit the SAME credential/tx — do NOT call `pay()` again (that re-signs /
re-broadcasts). The viem wallet must already be on the challenge's chain, or
`pay()` refuses (pass `allowChainMismatch` to override).

## b402 — Binance OnchainPay (x402)

Both b402 integrations are folded into the pair (see [`docs/b402.md`](b402.md)
for the full guide):

- **mppx settle backend** — server mode 3 (`B402Adapter`): buyers keep the
  mppx wire; only the settle step changes. Client side: the `authorization`
  tab on a `$U` preset.
- **standalone B402 Exact wire** — server LEVEL 3 (`/x402/premium`) advertises
  `eip3009` and/or `permit2-exact`; application buyers can use
  `createB402PaymentClient`. The educational browser keeps its manual
  `x402 · Permit2` tab. The server pins the complete offer and surfaces an
  ambiguous `/settle` outcome as `settlement.status === 'unknown'` instead of
  treating it as an ordinary rejection.

## What you need on-chain

Default flows run on **BSC Testnet** (`bsc-testnet` / TEST_USDT, a plain
BEP-20 with no EIP-3009):

- **hash** — the payer wallet broadcasts the transfer: needs tBNB (gas)
  \+ test USDT.
- **permit2 (mppx)** — payer needs test USDT + a one-time Permit2 approval
  (the client's allowance panel does it); the server's settlement signer
  needs tBNB for gas (mode 2).
- **authorization ($U via b402)** — the buyer only signs (no gas).
  ⚠️ Settlement works on **mainnet only** today (real `$U`); don't spend
  effort acquiring testnet `$U` for this tab — testnet authorization settles
  currently fail upstream ([adr/0004](adr/0004-b402-permit2.md) OQ2), so on
  testnet the tab stops at sign+submit.
- **x402 · Permit2** — one-time `approve(Permit2, max)` needs gas
  (tBNB/BNB); after that, sign-only. On testnet, b402's `/supported` lists
  permit2-exact for PancakeSwap TEST_USDT — so with testnet b402 credentials
  the whole x402 path runs on faucet tokens.

Faucets: [BNB Chain testnet faucet](https://www.bnbchain.org/en/testnet-faucet)
(tBNB); test USDT is PancakeSwap's BSC Testnet USDT at
[`0x337610…34dDd`](https://testnet.bscscan.com/token/0x337610d27c682E347C9cD60BD4b3b107C9d34dDd).
