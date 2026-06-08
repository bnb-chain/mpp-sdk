# charge-demo — interactive browser playground

A React app that drives `@bnb-chain/mpp` **end-to-end** on **BSC Testnet
(chainId 97)** with **USDT**, against a local `charge-server`: fetch a real
`402` challenge, build a credential (real on-chain broadcast / real MetaMask
EIP-712 signature), re-verify it, submit it back, and the server settles
on-chain and returns a `Payment-Receipt`.

This build demos the **`hash`** and **`permit2`** methods only, and runs in
end-to-end mode with the on/off toggle **hidden** (always on). The
`transaction` / `authorization` methods still exist in the code but are
hidden from the UI.

Stack: **React 18 + Tailwind + shadcn/ui + wagmi v2 + RainbowKit**, built
with Vite.

## What it exercises

- **2 credential types** — hash (the payer broadcasts the USDT transfer) +
  permit2 (real wallet-signed EIP-712; the server settles via
  `permitWitnessTransferFrom`; single + batch with splits)
- **End-to-end settlement** — both methods produce a real on-chain
  settlement and a server-issued `Payment-Receipt`
- **Permit2 allowance panel** — reads `ERC20.allowance(wallet, Permit2)`
  live and offers a one-click `approve(Permit2, max)` when needed
- **Server config panel** — reads `/api/config` to show what the deployment
  actually accepts (chain / token / credentialTypes / recipient)
- Re-verification — EIP-712 sig recovery (Permit2 single + batch) and
  decoded `Transfer`-log match for hash
- Per-credential-type state — each tab keeps its own challenge /
  credential / output, so switching tabs never bleeds state

## Per-credential realism

| Tab         | What's real                                                                                                                                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hash**    | Fully real — your wallet broadcasts a USDT transfer on BSC Testnet; the credential references the tx hash; the server verifies the on-chain `Transfer` log and returns a receipt.                                                       |
| **Permit2** | Real EIP-712 signature (MetaMask popup) bound to the server's settlement-signer `spender`; the server then broadcasts `permitWitnessTransferFrom` to settle and returns a receipt. Needs a one-time Permit2 approval (allowance panel) + the server signer funded with tBNB. |

## Run

This build runs **end-to-end**, so it needs the `charge-server` too —
start both:

```bash
# Terminal 1 — the server (see examples/charge-server/README.md for .env;
# its settlement signer must hold tBNB for Permit2 gas)
pnpm --filter @bnb-chain/mpp-example-charge-server start   # → :3000

# Terminal 2 — this demo
pnpm --filter @bnb-chain/mpp-example-charge-demo dev        # → :5173
```

Vite proxies `/api/*` → `http://localhost:3000` (override with
`VITE_CHARGE_SERVER_URL`), so the browser talks to the server without CORS.
BSC Testnet RPC defaults to `https://data-seed-prebsc-1-s1.binance.org:8545`;
override with `VITE_BSC_TESTNET_RPC_URL`.

`pnpm dev` runs `predev` first (`pnpm -C ../.. build`) to rebuild the SDK
`dist/` the demo bundles against. (`dist/` is gitignored, so a fresh
clone needs this once; it's a ~1s no-op on incremental rebuilds.
`pnpm --filter @bnb-chain/mpp build` would silently no-op from inside
this workspace — pnpm resolves names against the cwd's visible workspace
subset — so the hook uses `-C ../..` to jump to the repo root.) Both
`predev` and the server's `prestart` need **Node ≥22**.

## Flow

1. **Connect wallet** — RainbowKit Connect button in the header; switch
   to BSC Testnet (chainId 97) when prompted.
2. **Pick a credential type** — the `Hash` / `Permit2` tab bar. The
   realism callout under the tabs says what settles on-chain for each.
3. **Config** — chain / token / recipient / amount mirror the server's
   `402` (read-only); the binding mode is `mppx-managed`.
4. **Run** — step buttons in order, or **⚡ Run All**:
   - **1 · Fetch challenge** — GET `/api/article`, parse the `402`'s
     `WWW-Authenticate` via `Challenge.deserialize`, sync the form to the
     server's request (auto-runs once on page load too).
   - **2 · Build credential** — `createXxxCredential(...)` from
     `@bnb-chain/mpp/client`. Hash broadcasts the USDT transfer first;
     Permit2 pops MetaMask for the EIP-712 signature (signed against the
     server's `permit2Spender`).
   - **3 · Local verify** — the SDK's own typed-data recovery (Permit2) /
     Transfer-log decode (hash) against the credential.
   - **4 · Submit & settle** — re-hit `/api/article` with
     `Authorization: Payment ...`; the server verifies + settles on-chain
     and returns `200` + `Payment-Receipt`, which the demo deserializes and
     checks against the challenge.

Each step renders a collapsible output card with the wire JSON, BscScan
links, and a pass/fail summary; the step pills animate idle → running →
ok / err.

## Topping up tBNB + test USDT

- **Hash**: your wallet broadcasts the transfer, so it needs tBNB (gas) +
  test USDT on BSC Testnet.
- **Permit2**: your wallet is the payer (needs test USDT) and does a
  one-time Permit2 `approve` (allowance panel; ~tBNB); the **server's**
  settlement signer needs tBNB to broadcast the `permitWitnessTransferFrom`
  settlement.

Faucets:

- tBNB — [BNB Chain testnet faucet](https://testnet.bnbchain.org/faucet-smart)
  (the status bar links it directly when connected)
- test USDT — the demo uses PancakeSwap's BSC Testnet USDT at
  [`0x337610…34dDd`](https://testnet.bscscan.com/token/0x337610d27c682E347C9cD60BD4b3b107C9d34dDd)

## Source layout

```
src/
├── main.tsx                 WagmiProvider + QueryClient + RainbowKit wrap
├── App.tsx                  top-level state + step orchestration + per-type pools
├── index.css                Tailwind base + shadcn CSS vars (BNB yellow accent)
├── components/
│   ├── ui/*.tsx             shadcn primitives (Button, Card, Tabs, Select, ...)
│   ├── Header / StatusBar   wallet header + BSC Testnet status bar
│   ├── ConfigPanel          chain / binding / amount / recipient / realm
│   ├── CredentialTabsBar    the visible credential-type tabs (hash + permit2)
│   ├── RealismCallout       per-tab "what's real" note
│   ├── SplitsEditor         Permit2 batch splits editor
│   ├── Permit2AllowancePanel  live allowance read + one-click approve
│   ├── InPageKeyPanel       transaction-credential in-page key
│   ├── StepBar / StepButtons  step pills + Run All / Clear + per-step buttons
│   ├── OutputPanel          collapsible output cards
│   └── JsonBlock / VerifyList  JSON pretty-printer + verify-line list
├── hooks/usePersistedState.ts   localStorage-backed useState
└── lib/
    ├── wagmi.ts             BSC-Testnet-only wagmi config (MetaMask via RainbowKit)
    ├── types.ts             ExecState (per-type) + DemoState (flat snapshot)
    ├── actions.tsx          the 7 step actions (fetch / build / verify / submit / receipt)
    └── utils.ts             cn() class-merge helper
```

`src/presets.ts` mirrors the chain / token metadata from
`src/server/curated.ts` (the demo doesn't run `preflightCharge`, so it
duplicates the values it needs to build wire requests). The Tailwind
theme lives in `tailwind.config.js` + `src/index.css`.
