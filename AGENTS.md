# AGENTS.md

Quick-start orientation for AI coding agents and human contributors
landing in this repo.

## Source of truth

- **Wire shape**: `src/Methods.ts` (`chargeMethod`). Server
  (`@bnb-chain/mpp/server`) and client (`@bnb-chain/mpp/client`) both
  import this one Method instance — a wire change can't be made one-sided.
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
- **Packages**: top-level barrel `@bnb-chain/mpp` (`chargeFromDecimal` +
  receipt codec), `@bnb-chain/mpp/server` (factory + verifiers),
  `@bnb-chain/mpp/client` (credential constructors), `@bnb-chain/mpp/b402`
  (+ `/server`, `/mppx`) — the Binance OnchainPay (x402 v2) facilitator
  integration, parallel to the mppx charge flow (see
  [`docs/b402.md`](docs/b402.md)).

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
- **b402**: EIP-3009 settlement through `B402Adapter`; standalone B402 Exact
  (`eip3009` + `permit2-exact`) through `createB402Extension().exact()`;
  browser-safe high-level buyer client; runtime facilitator response parsing;
  shared TTL `/supported` cache; structured settlement-unknown results.
  `permit2-upto` remains intentionally unsupported.

## When touching wire contracts

Re-read the relevant spec section before changing any of:

- `src/Methods.ts` (the wire schema)
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
└── b402/                       x402 v2 facilitator integration (parallel to charge;
    │                           only shared seam = protocol/TypedData.ts)
    ├── Types.ts                x402 v2 wire types (browser-safe)
    ├── Payload.ts              buildEip3009Payment / X-PAYMENT(-RESPONSE) codecs /
    │                           recoverEip3009Payer / nonce (browser-safe)
    ├── Permit2.ts              permit2-exact builder / validator / payer recovery
    ├── Buyer.ts                high-level B402 Exact buyer (probe/select/sign/retry;
    │                           Permit2 approval is explicit)
    ├── Client.ts               B402Client — RSA "Tesla" signed /supported·/verify·/settle (Node)
    ├── Response.ts             runtime parsers for facilitator success bodies
    ├── Supported.ts            TTL + single-flight /supported cache
    ├── Exact.ts                shared eip3009 + permit2-exact merchant handler/invariants
    ├── Gate.ts                 compatibility wrappers for legacy Permit2 Exact Gate APIs
    ├── index.ts                `@bnb-chain/mpp/b402` barrel (browser-safe, core-free)
    ├── server/index.ts         `@bnb-chain/mpp/b402/server` barrel (Node-only APIs)
    └── mppx/index.ts           `@bnb-chain/mpp/b402/mppx` — createB402Extension +
                                B402Adapter (the b402 subpath that imports core)
test/                           vitest config + setup; live/ = testnet e2e scaffolds
├── helpers/server/             test seams kept OUT of the published src tarball
│                               (preflightChargeForTest, terminalFailureStore)
└── interop/                    viem cross-check vectors
examples/                       exactly two: server (Hono merchant — mppx modes
                                1-3 + optional /x402 B402 Exact route) and
                                client (React browser wallet — both wires).
                                b402 is folded into these: server mode 3
                                (B402Adapter) + standalone B402 Exact;
                                client $U authorization + x402 tabs — see docs/examples.md
docs/                           public docs (architecture, spec-compliance, replay-store, examples, adr/)
```

## Common commands

```bash
nvm use 22                    # any Node 22+; no .nvmrc pinning
pnpm install                  # corepack auto-bumps pnpm to 11.0.8
pnpm check                    # lint --fix + fmt --write
pnpm check:types              # tsgo -b + test config + example workspaces
pnpm test                     # vp test --config vite.config.ts
pnpm test -- --project unit   # unit only (the `--` is required — without it
                              # some pnpm versions consume `--project`)
pnpm build                    # zile -> dist/
```

## Generated / ignored files

- `dist/`, `coverage/`, `*.tsbuildinfo` — build output.
- `tmp/` — internal spec + scratch; gitignored.
- `examples/*/.env` — local secrets; only `.env.example` is committed.
- `pnpm-lock.yaml` / `pnpm-workspace.yaml` — managed by pnpm; the
  workspace file lists `onlyBuiltDependencies` for the native deps wagmi
  pulls in (`bufferutil` / `keccak` / `utf-8-validate`).
