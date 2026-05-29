# charge-demo — interactive browser playground

A React app that exercises every client-side feature of `@bnb-chain/mpp`
against a **real local `charge-server`** on Sepolia: fetch a real `402`,
build a credential (real MetaMask EIP-712 signatures / real on-chain
broadcast), submit it back, and verify the `Payment-Receipt`.

Stack: **React 18 + Tailwind + shadcn/ui + wagmi v2 + RainbowKit**, built
with Vite.

## What it exercises

- **4 credential types** — hash / transaction / permit2 (single + batch
  with splits) / authorization (EIP-3009)
- **3 challenge binding modes** — mppx-managed / mppx-hmac / stored-lookup
  (local mode only; end-to-end mode forces mppx-managed to match the
  server)
- **End-to-end mode (default ON)** — real `402` roundtrip against
  `examples/charge-server`: fetch challenge → build credential → submit →
  `Payment-Receipt`
- **Local mode** — construct the challenge / synthesize the receipt
  client-side with no server (toggle end-to-end mode off)
- **Permit2 allowance panel** — reads `ERC20.allowance(wallet, Permit2)`
  live and offers a one-click `approve(Permit2, max)` when needed
- `chargeFromDecimal` decimal → base-units conversion (live as you type)
- Local re-verification — EIP-712 sig recovery (Permit2 single + batch,
  EIP-3009), EIP-1559 tx parse + selector, decoded `Transfer`-log match
  for hash
- Per-credential-type state — each tab keeps its own challenge /
  credential / output, so switching tabs never bleeds state
- Form + toggles persist via `localStorage`

## Per-credential realism

| Tab               | What's real                                                                                                                                                                                                                                                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hash**          | Fully real — wallet broadcasts a USDC transfer on Sepolia; the credential references the actual tx hash; the server's verifier decodes the on-chain `Transfer` log.                                                                                                                                                                                      |
| **Permit2**       | Real EIP-712 signature (MetaMask popup); server settles via `permitWitnessTransferFrom`. Needs a one-time Permit2 approval (the allowance panel handles it) + Sepolia ETH on the server signer for gas.                                                                                                                                                  |
| **Authorization** | Real EIP-3009 signature (MetaMask popup); server settles via `transferWithAuthorization`. No prior approval needed; server signer pays gas.                                                                                                                                                                                                              |
| **Transaction**   | Partial — MetaMask can't expose a pre-signed-but-unbroadcast EIP-1559 RLP (`eth_signTransaction` isn't in the standard provider surface). The demo signs with an in-page random key so the wire shape is real; that key has no funds, so end-to-end settlement intentionally fails at broadcast. Production callers sign with their own funded keystore. |

## Run

End-to-end mode (the default) needs the `charge-server` running too —
start both:

```bash
# Terminal 1 — the server (see examples/charge-server/README.md for .env)
pnpm --filter @bnb-chain/mpp-example-charge-server start   # → :3000

# Terminal 2 — this demo
pnpm --filter @bnb-chain/mpp-example-charge-demo dev        # → :5173
```

Vite proxies `/api/*` → `http://localhost:3000` (override with
`VITE_CHARGE_SERVER_URL`), so the browser talks to the server without
CORS. Sepolia RPC defaults to publicnode; override with
`VITE_SEPOLIA_RPC_URL`.

`pnpm dev` runs `predev` first (`pnpm -C ../.. build`) to rebuild the SDK
`dist/` the demo bundles against. (`dist/` is gitignored, so a fresh
clone needs this once; it's a ~1s no-op on incremental rebuilds.
`pnpm --filter @bnb-chain/mpp build` would silently no-op from inside
this workspace — pnpm resolves names against the cwd's visible workspace
subset — so the hook uses `-C ../..` to jump to the repo root.)

If you only want to inspect wire shapes without a server, toggle
**End-to-end mode** off — step 1 then builds the challenge locally and
step 4 synthesizes the receipt client-side.

## Flow

1. **Connect wallet** — RainbowKit Connect button in the header; switch
   to Sepolia when prompted.
2. **Pick a credential type** — the tab bar. The realism callout under
   the tabs says what's on-chain vs in-page for each.
3. **Configure** — amount (Permit2 also has a splits editor). In
   end-to-end mode, chain / token / recipient / amount come from the
   server's `402` and the form fields are read-only.
4. **Run** — step buttons in order, or **⚡ Run All**:
   - **1 · Fetch challenge** — GET `/api/article`, parse the `402`'s
     `WWW-Authenticate` via `Challenge.deserialize`, sync the form to the
     server's request. (Local mode: `Challenge.from({...})` instead.)
   - **2 · Build credential** — `createXxxCredential(...)` from
     `@bnb-chain/mpp/client`. Hash broadcasts the USDC transfer first;
     Permit2 / Authorization pop MetaMask for the EIP-712 signature.
   - **3 · Local verify** — the SDK's own typed-data recovery / parse /
     Transfer-log decode against the credential. (HMAC verify is skipped
     in end-to-end mode — the server's secret isn't exposed to the
     client.)
   - **4 · Submit & settle** — re-hit `/api/article` with
     `Authorization: Payment ...`; the server verifies + settles on-chain
     and returns `200` + `Payment-Receipt`, which the demo deserializes
     and checks against the challenge. (Local mode: `buildEvmReceipt` →
     `serializeEvmReceipt` → `deserializeEvmReceipt` round-trip instead.)

Each step renders a collapsible output card with the wire JSON, Etherscan
links, and a pass/fail summary; the step pills animate idle → running →
ok / err.

## Topping up Sepolia ETH + test USDC

- **Hash**: the connected wallet broadcasts the transfer, so it needs
  Sepolia ETH (gas) + Sepolia USDC.
- **Permit2 / Authorization**: the wallet needs Sepolia USDC (it's the
  payer); the **server's settlement signer** needs Sepolia ETH for gas
  (it broadcasts the settlement tx).

Faucets:

- Sepolia ETH — [sepoliafaucet.com](https://sepoliafaucet.com),
  [Google Cloud faucet](https://cloud.google.com/application/web3/faucet/ethereum/sepolia)
- Sepolia USDC — [Circle's faucet](https://faucet.circle.com) (the status
  bar links it directly when on Sepolia)

## Source layout

```
src/
├── main.tsx                 WagmiProvider + QueryClient + RainbowKit wrap
├── App.tsx                  top-level state + step orchestration + per-type pools
├── index.css                Tailwind base + shadcn CSS vars (BNB yellow accent)
├── components/
│   ├── ui/*.tsx             shadcn primitives (Button, Card, Tabs, Select, ...)
│   ├── Header / StatusBar   wallet header + Sepolia status bar
│   ├── ConfigPanel          chain / binding / amount / recipient / realm + server-mode toggle
│   ├── CredentialTabsBar    the 4 credential-type tabs
│   ├── RealismCallout       per-tab "what's real" note
│   ├── SplitsEditor         Permit2 batch splits editor
│   ├── Permit2AllowancePanel  live allowance read + one-click approve
│   ├── InPageKeyPanel       transaction-credential in-page key
│   ├── StepBar / StepButtons  step pills + Run All / Clear + per-step buttons
│   ├── OutputPanel          collapsible output cards
│   └── JsonBlock / VerifyList  JSON pretty-printer + verify-line list
├── hooks/usePersistedState.ts   localStorage-backed useState
└── lib/
    ├── wagmi.ts             Sepolia-only wagmi config (MetaMask via RainbowKit)
    ├── types.ts             ExecState (per-type) + DemoState (flat snapshot)
    ├── actions.tsx          the 7 step actions (fetch / build / verify / submit / receipt)
    └── utils.ts             cn() class-merge helper
```

`src/presets.ts` mirrors the chain / token metadata from
`src/server/curated.ts` (the demo doesn't run `preflightCharge`, so it
duplicates the values it needs to build wire requests). The Tailwind
theme lives in `tailwind.config.js` + `src/index.css`.
