# AGENTS.md

Quick-start orientation for AI coding agents and human contributors
landing in this repo.

## Source of truth

- **Wire shapes**: `src/Methods.ts` (generic `evm/charge`) and
  `packages/mpp-b402/src/Methods.ts` (`b402/charge`). Each server/client pair
  imports its one shared Method instance — a wire change can't be made one-sided.
- **Public docs**: [`docs/`](docs/) — `architecture.md`,
  `spec-compliance.md`, `replay-store.md`, `examples.md`, and
  `adr/` (architecture decision records).
- **Implementation spec**: `tmp/REWRITE-SPEC.md` is the detailed internal
  spec. It is intentionally **not committed** (`tmp/` is gitignored — it
  carries sensitive deployment context). When it conflicts with this
  file, it wins. Contributors who need it request access from the
  maintainers; the committed codebase + `docs/` are self-contained for
  review and execution.

## Project shape

- **Language**: TypeScript (ESM), Node ≥ 22 (dev uses Node 22 stable),
  package manager **pnpm 11** via `packageManager` + corepack. No
  `.nvmrc`. `@types/node@24` is type-only and does NOT force Node 24 —
  `engines.node` stays `>=22`.
- **Toolchain (mirrors mppx)**: `vp` (vite-plus) for lint/fmt/test,
  `tsgo` for type-check, `zile` for build. Do NOT swap to
  `tsc`/`eslint`/`prettier` — the stack is deliberately pinned to mppx's.
- **Packages**: `@bnb-chain/mpp` (generic EVM Charge), `@bnb-chain/b402`
  (B402 Provider Module + official x402 Adapters), and
  `@bnb-chain/mpp-b402` (MPP `b402/charge` Adapter). See
  [`docs/architecture.md`](docs/architecture.md) and
  [`docs/b402.md`](docs/b402.md).

## Current implementation status

All four credential paths + all three challenge-binding modes are live
end-to-end:

- **Credentials**: `hash` (`src/server/Hash.ts`, §8.4), `transaction`
  (`Transaction.ts`, §8.3), `permit2` single + batch (`Permit2.ts`, §8.1),
  `authorization` EIP-3009 (`Authorization.ts`, §8.2).
- **Binding**: `mppx-managed` / `mppx-hmac` / `stored-lookup`
  (`ChallengeBinding.ts` + `ChallengeStore.ts`, §8.0).
- **Spec extension**: `methodDetails.permit2Spender` (Permit2 path only)
  — see [`docs/spec-compliance.md`](docs/spec-compliance.md) +
  [`docs/adr/0001-permit2-spender.md`](docs/adr/0001-permit2-spender.md).
- **Curated matrix**: `src/server/curated.ts`. Note `TEST_USDT` on
  `opbnb-testnet` (NOT `bsc-testnet`, which is pinned to a real verified
  contract) carries a sentinel zero address (rejected by `preflightCharge`)
  pending a real verified opBNB testnet contract before any live-test
  broadcast.
- **B402**: `@bnb-chain/b402` supports direct official x402 EIP-3009 +
  Permit2 Exact. `@bnb-chain/mpp-b402` exposes both through `b402/charge` and
  retains `createB402Facilitator()` for the standard mppx EIP-3009 Seam.
  Standalone Gate/buyer orchestration and `permit2-upto` are unsupported.

## When touching wire contracts

Re-read the relevant spec section before changing any of:

- `src/Methods.ts` or `packages/mpp-b402/src/Methods.ts` (wire schemas)
- `packages/b402/src/TypedData.ts` (B402 EIP-3009 typed data)
- `src/protocol/TypedData.ts` (EIP-712 Permit2 + EIP-3009 type strings)
- `src/server/Receipt.ts` (the `draft §7.6` receipt fields)

These are byte-for-byte cross-implementation interop contracts. When you
touch an mppx API, confirm against the pinned commit
`b4334f0f0683930a1c9061d78de3a5255caaf962` (`mppx@0.8.12`):
`gh api repos/wevm/mppx/contents/<path>?ref=$MPPX_SHA`.

## Workflow rules

1. **`tmp/` is gitignored** — drop spec / plan / scratch notes there;
   never commit them.
2. Run `pnpm check && pnpm check:types && pnpm test` before every commit.
   CI runs `pnpm check:ci` + `pnpm test`.
3. **Don't push** to `main` or `v1`. Feature branches only.
   Releases ship from `v1` via the changesets workflow — see
   [`docs/releasing.md`](docs/releasing.md).
4. Commit messages: explain what changed and why; reference the spec
   section a public-facing change implements.
5. Keep source comments about the _rule / invariant_ ("why it must be
   this way"), not the review round that introduced it.
6. **Reviewing repo structure**: enumerate with `git ls-files` (or
   `git ls-files <dir>`), not `ls -R` / `find` / `tree`. Only the tracked
   set matters — `dist/`, `coverage/`, `node_modules/`, and `tmp/` are
   ignored, and walking them buries the real layout in build noise.

## File map

```
src/
├── Methods.ts                  wire schema + chargeMethod
├── index.ts                    `@bnb-chain/mpp` barrel: chargeFromDecimal
│                               + browser-safe receipt codec re-exports
├── internal/
│   ├── Account.ts              viem account re-exports
│   └── Chain.ts                viem chain re-exports
├── protocol/                   wire-contract layer (EIP-712 + version pins)
│   ├── TypedData.ts            EIP-712 Permit2 + EIP-3009 type strings + frozen-hex fixtures
│   └── Version.ts              MPPX_SHA, DRAFT_VERSION, CANONICAL_PERMIT2_ADDRESS
├── server/
│   ├── Charge.ts               preflightCharge + charge factory + verify routing
│   ├── ChallengeBinding.ts     mppx-managed + mppx-hmac + stored-lookup (§8.0)
│   ├── ChallengeStore.ts       rememberChallenge + lookup primitives (stored-lookup)
│   ├── Authorization.ts        EIP-3009 transferWithAuthorization verifier (§8.2)
│   ├── Hash.ts                 hash credential verifier (§8.4)
│   ├── Permit2.ts              permit2 single + batch verifier (§8.1)
│   ├── Transaction.ts          full EIP-1559 transaction verifier (§8.3)
│   ├── Receipt.ts              buildEvmReceipt + (de)serializeEvmReceipt (browser-safe)
│   ├── Replay.ts               3-state CAS store + per-credential key factories
│   ├── Settlement.ts           resolveSettlementSigner with all guards
│   ├── Transport.ts            optional fail-closed EVM receipt transport
│   ├── curated.ts              SupportedChainPreset / SupportedTokenPreset + TOKEN_MATRIX
│   └── index.ts                `@bnb-chain/mpp/server` barrel
├── client/
│   ├── Authorization.ts        createAuthorizationCredential (EIP-3009 signer)
│   ├── Hash.ts                 createHashCredential (tx-hash reference; no signing)
│   ├── Permit2.ts              createPermit2Credential (single + batch with splits)
│   ├── Transaction.ts          createTransactionCredential (EIP-1559 signer)
│   ├── internal/
│   │   └── AssertChallenge.ts  parseEvmChargeChallenge + accepted-types / drift / splits guards
│   ├── pay/                    pay(url, { wallet, policy }) high-level buyer surface —
│   │                           index (orchestrator) + routes/facts/build/request
│   │                           (ADR-0003 Phase 1; hard-filter → mode-rank → fail-closed)
│   └── index.ts                `@bnb-chain/mpp/client` barrel — the four credential
│                               constructors + the high-level pay().
test/                           vitest config + setup; live/ = testnet e2e scaffolds
├── helpers/server/             test seams kept OUT of the published src tarball
│                               (preflightChargeForTest, terminalFailureStore)
└── interop/                    viem cross-check vectors
examples/                       exactly two: server (minimal Hono merchant) and
                                client (React wallet), demonstrating only the
                                MPP-native B402 EIP-3009 + Permit2 Exact paths
                                — see docs/examples.md
docs/                           public docs (architecture, spec-compliance, replay-store, examples, adr/)
packages/
├── b402/                       `@bnb-chain/b402`
│   └── src/
│       ├── Types/Payload/Permit2/Requirements/TypedData
│       ├── client/             official x402 buyer Scheme + allowance policy
│       └── server/             RSA transport, cache, settlement, facilitator + server Scheme
└── mpp-b402/                   `@bnb-chain/mpp-b402`
    └── src/
        ├── Methods.ts          `b402/charge` wire contract
        ├── client/             MPP wallet Adapter
        └── server/             MPP merchant + mppx EIP-3009 Adapter
```

## Common commands

```bash
nvm use 22                    # any Node 22+; no .nvmrc pinning
pnpm install                  # corepack auto-bumps pnpm to 11.0.8
pnpm check                    # lint --fix + fmt --write
pnpm check:types              # tsgo -b + test config + example workspaces
pnpm test                     # vp test --config vite.config.ts
pnpm test --project unit      # unit only
pnpm build                    # build all three publishable packages
```

## Generated / ignored files

- `dist/`, `coverage/`, `*.tsbuildinfo` — build output.
- `tmp/` — internal spec + scratch; gitignored.
- `examples/*/.env` — local secrets; only `.env.example` is committed.
- `pnpm-lock.yaml` / `pnpm-workspace.yaml` — managed by pnpm; the
  workspace file lists `onlyBuiltDependencies` for the native deps wagmi
  pulls in (`bufferutil` / `keccak` / `utf-8-validate`).
