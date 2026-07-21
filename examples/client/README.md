# client — interactive browser buyer

> **New here?** Jump to [Run](#run) — the first success is the **Hash** tab
> against a LEVEL-0 server, nothing else needed.

A React app that drives `@bnb-chain/mpp` **end-to-end** against
[`examples/server`](../server), on **both wires**:

- the **mppx charge wire** (`WWW-Authenticate: Payment` →
  `Authorization: Payment` → `Payment-Receipt`) — the `Hash` / `Permit2` /
  `Authorization` tabs;
- the **standalone x402 wire** (JSON `402` body → `X-PAYMENT` →
  `X-PAYMENT-RESPONSE`) — the server now advertises B402 Exact EIP-3009 and/or
  Permit2 Exact. This educational UI keeps the manual `x402 · Permit2` tab so
  every approval/signing step is visible; application code can instead use
  `createB402PaymentClient`.

Every step is real: real `402`s fetched from the local server, real MetaMask
signatures / broadcasts, real settlement + receipts. Which tabs settle
depends on the server's `.env` (see its
[.env.example](../server/.env.example) and the
[table below](#tabs--server-modes)).

Stack: **React 18 + Tailwind + shadcn/ui + wagmi v2 + RainbowKit**, built
with Vite.

## Run

All commands from the **repo root**:

```bash
# Terminal 1 — the server (LEVEL 0 .env: RECIPIENT_ADDRESS + MPP_SECRET_KEY;
# cp examples/server/.env.example examples/server/.env first)
pnpm --filter @bnb-chain/mpp-example-server start    # → :3001

# Terminal 2 — this client
pnpm --filter @bnb-chain/mpp-example-client dev      # → :5173
```

**First success = the Hash tab**: connect MetaMask on BSC Testnet (faucet
tBNB + TEST_USDT below), stay on **Hash**, hit **⚡ Run All**. The other tabs
are advanced flows that need the matching server level — see the
[table below](#tabs--server-modes).

Vite proxies `/api/*` and `/x402/*` → `http://localhost:3001` (override with
`VITE_CHARGE_SERVER_URL` in a local `.env`), so the browser talks to the
server without CORS. Chain RPCs default to public endpoints; override with
`VITE_BSC_TESTNET_RPC_URL` / `VITE_BSC_RPC_URL`.

**Stale localStorage** — the endpoint always follows the `.env` default, but
the selected chain preset and active tab persist from earlier visits (the
in-app **Clear** button only resets the current tab's outputs, not these
preferences): after changing `.env`, switch the preset via the Chain
dropdown, or clear site data in DevTools.

`pnpm dev` runs `predev` first (`pnpm -C ../.. build`) to rebuild the SDK
`dist/` the demo bundles against. (`dist/` is gitignored, so a fresh clone
needs this once; it's a ~1s no-op on incremental rebuilds. Both `predev` and
the server's `prestart` need **Node ≥22**.)

## Configuration — what the client calls

Zero-config pairs with `examples/server` on :3001. Everything below is an
OPTIONAL override (`.env`, see [.env.example](.env.example)); all payment
facts — amount, recipient, token, spender — come off the server's 402 at
runtime, so there is nothing else to configure client-side.

| `.env` setting                                  | Default                 | What it does                                                                                |
| ----------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------- |
| `VITE_CHARGE_SERVER_URL`                        | `http://localhost:3001` | vite proxy target for BOTH wires (`/api/*` and `/x402/*`)                                   |
| `VITE_DEFAULT_ENDPOINT`                         | `/api/premium`          | the mppx resource the **Hash / Permit2 / Authorization** tabs pay                           |
| `VITE_X402_ENDPOINT`                            | `/x402/premium`         | the x402 resource the **x402 · Permit2** tab pays                                           |
| `VITE_DEFAULT_CHAIN_KEY`                        | `bsc-testnet`           | starting chain preset — picks which tabs surface and which network's x402 offer is accepted |
| `VITE_BSC_TESTNET_RPC_URL` / `VITE_BSC_RPC_URL` | public endpoints        | wallet-side chain reads (balances, receipts)                                                |

The server-side view of the same mapping — which route accepts what, and who
settles it — is the
[route map in the server README](../server/README.md#route-map--which-path-each-resource-takes).

## Tabs × server modes

The chain preset drives which tabs appear; the server's `.env` decides which
of them settle:

| Tab                | Preset                            | Pays (endpoint) | Settles against a server running | What's real                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------ | --------------------------------- | --------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hash**           | BSC Testnet (USDT)                | `/api/premium`  | mode 1 or 2 (LEVEL 0/1)          | Fully real — your wallet broadcasts a TEST_USDT transfer; the credential references the tx hash; the server verifies the on-chain `Transfer` log and returns a receipt.                                                                                                                                                                                                         |
| **Permit2**        | BSC Testnet (USDT)                | `/api/premium`  | mode 2 (LEVEL 1)                 | Real EIP-712 signature (MetaMask popup) bound to the server's settlement-signer `spender`; the server broadcasts `permitWitnessTransferFrom` and returns a receipt. Needs the one-time Permit2 approval (allowance panel) + the server signer funded with tBNB.                                                                                                                 |
| **Authorization**  | $U presets (testnet / ⚠️ mainnet) | `/api/premium`  | mode 3 (LEVEL 2)                 | Real EIP-3009 `transferWithAuthorization` signature — no gas, no buyer-side broadcast. The mode-3 server settles it through b402 (broadcasts + pays gas). ⚠️ Settles work on the MAINNET preset only today (REAL `$U`); on testnet the facilitator kind mismatches the token domain ([ADR-0004](../../docs/adr/0004-b402-permit2.md) OQ2), so that preset stops at sign+submit. |
| **x402 · Permit2** | every preset                      | `/x402/premium` | mode 3 + LEVEL 3                 | The standalone x402 wire against `/x402/premium`: fetch the 402 JSON offer, one-time on-chain `approve(Permit2, max)` if allowance is short (**costs gas** ⚠️), MetaMask signs `PermitWitnessTransferFrom`, pay with the `X-PAYMENT` header — b402 broadcasts the transfer.                                                                                                     |

> **The server's mppx modes don't stack.** Modes 1/2 charge TEST_USDT; mode 3
> (b402) **switches** the mppx route to `$U`/`authorization` only — against a
> mode-3 server the Hash/Permit2 tabs no longer settle (wrong token, wrong
> credential type). LEVEL 3 (the x402 route) rides **alongside** mode 3, so a
> mode-3 pairing exercises the `Authorization` + `x402 · Permit2` tabs.

(The mpp wire also defines a `transaction` credential — a pre-signed
EIP-1559 transfer — not demoed here because MetaMask can't expose a
pre-signed-unbroadcast transaction; Node buyers with their own keystore can
build it via `createTransactionCredential`.)

## The x402 · Permit2 tab, in detail

This tab speaks a **different protocol** from the other three — pure x402 v2,
the wire b402 (Binance OnchainPay) uses natively. It's the road for tokens
without a usable EIP-3009 door (USDT/USDC, or `$U` deployments whose EIP-712
domain doesn't match the facilitator's eip3009 kind):

1. **Fetch 402 offer** — GET `/x402/premium` → JSON `{ accepts: [...] }`;
   the tab picks the `exact`/`permit2-exact` offer for the selected preset's
   chain and shows whether the offered spender is in the SDK's curated b402
   allowlist.
2. **Approve + sign** — if `ERC20.allowance(wallet, Permit2)` is short, a
   one-time `approve(Permit2, max)` wallet tx is sent and awaited (needs
   native gas; every later payment is sign-only). Then MetaMask signs the
   `PermitWitnessTransferFrom` typed data via the SDK's
   `buildPermit2ExactPayment`.
3. **Local verify** — `isPermit2PaymentPayload` full-shape gate + EIP-712
   recovery + the offer bindings (spender allowlisted, `witness.to == payTo`,
   amount pinned 1:1).
4. **Pay** — GET again with `X-PAYMENT`; the server relays to b402
   (`/verify` → `/settle`) and the tab decodes `X-PAYMENT-RESPONSE` (settle
   tx hash + explorer link).

**Security note (why signing can refuse):** a buyer cannot call b402's
`/supported` (it's RSA-gated), so the 402's `spenderAddress` is untrusted
input — and a Permit2 signature to a hostile spender is a token-theft
instrument. The SDK therefore refuses to sign for any spender outside
`trustedSpenders`; this demo passes the SDK's dated `CURATED_B402_SPENDERS`
`.exact` entry for the offered network and never trusts the wire value alone
([adr/0004](../../docs/adr/0004-b402-permit2.md)).

## Flow (all tabs)

1. **Connect wallet** — RainbowKit button in the header; match the wallet
   chain to the selected preset.
2. **Pick a tab** — the realism callout under the tabs says exactly what's
   real for each.
3. **Config** — the chain preset is yours to switch (it picks the visible
   tabs + the x402 offer's network); amount / recipient / realm mirror the
   server's 402 (read-only).
4. **Run** — step buttons in order, or **⚡ Run All**. Each step renders a
   collapsible output card with the wire JSON, BscScan links, and a
   pass/fail summary.

## Funding (BSC Testnet)

- **Hash** — tBNB (gas) + test USDT.
- **Permit2 (mppx)** — test USDT + one-time Permit2 approve (~tBNB); the
  server's signer pays settlement gas.
- **Authorization ($U)** — sign-only, no gas. ⚠️ Settlement is
  mainnet-only today (testnet settles fail upstream, ADR-0004 OQ2) — don't
  hunt down faucetless testnet `$U` for this tab.
- **x402 · Permit2** — the offered token + native gas for the one-time
  approve. With testnet b402 credentials the server can offer PancakeSwap
  TEST_USDT here (faucet-friendly, see the server's `.env.example` LEVEL 3).

Faucets: [tBNB](https://www.bnbchain.org/en/testnet-faucet) · test USDT =
PancakeSwap BSC Testnet USDT at
[`0x337610…34dDd`](https://testnet.bscscan.com/token/0x337610d27c682E347C9cD60BD4b3b107C9d34dDd).

## Source layout

```
src/
├── main.tsx                 WagmiProvider + QueryClient + RainbowKit wrap
├── App.tsx                  top-level state + step orchestration + per-tab pools
├── index.css                Tailwind base + shadcn CSS vars (BNB yellow accent)
├── actions/                 the step actions (one file each)
│   ├── fetchChallenge       step 1 (server 402 → Challenge + form sync)
│   ├── buildCredential      step 2 (createXxxCredential + hash broadcast)
│   ├── localVerify          step 3 (typed-data recovery / Transfer-log decode)
│   ├── submit               step 4 (re-GET with Authorization → receipt)
│   ├── x402                 ALL FOUR steps of the x402 · Permit2 tab
│   ├── shared               shared action helpers + panel factory
│   └── index.ts             action barrel
├── components/
│   ├── ui/*.tsx             shadcn primitives (Button, Card, Tabs, Select, ...)
│   ├── Header / StatusBar   wallet header + chain status bar
│   ├── ConfigPanel          chain preset selector + server-managed field mirrors
│   ├── CredentialTabsBar    the visible credential-type tabs (per chain preset)
│   ├── ServerConfigPanel    reads /api/config (optional deployment descriptor)
│   ├── RealismCallout       per-tab "what's real" note
│   ├── SplitsEditor         Permit2 batch splits editor
│   ├── Permit2AllowancePanel  live allowance read + one-click approve (mppx permit2)
│   ├── StepBar / StepButtons  step pills + Run All / Clear + per-step buttons
│   ├── OutputPanel / FailureCases  output cards + failure-case gallery
│   └── JsonBlock / VerifyList  JSON pretty-printer + verify-line list
├── hooks/usePersistedState.ts   localStorage-backed useState
├── protocol/presets.ts      chain / token presets + STORAGE_KEYS (mirrors curated.ts)
├── state/types.ts           ExecState (per-tab) + DemoState (flat snapshot)
└── lib/
    ├── wagmi.ts             BSC testnet + mainnet wagmi config (MetaMask via RainbowKit)
    └── utils.ts             cn() class-merge helper
```

`src/protocol/presets.ts` mirrors the chain / token metadata from
`src/server/curated.ts` (the demo doesn't run `preflightCharge`, so it
duplicates the values it needs to build wire requests). The Tailwind theme
lives in `tailwind.config.js` + `src/index.css`.
