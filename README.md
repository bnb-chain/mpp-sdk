# @bnb-chain/mpp

EVM Charge implementation of the [Machine Payments Protocol (mppx)](https://github.com/wevm/mppx) — `draft-evm-charge-00`.

Brings the BNB Chain ecosystem (BSC, opBNB) plus the wider EVM landscape (Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche, Linea) into the mppx HTTP payment authentication framework. Composes with `Mppx.create()` to expose `402 Payment Required` flows for `permit2`, `transaction`, `hash`, and `authorization` (EIP-3009) credentials.

## Capabilities

| Area                  | Supported                                                                                                                                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Credential types**  | `authorization` (EIP-3009), `permit2` (single + batch with splits), `transaction` (EIP-1559), `hash`                                                                                                                                |
| **Buyer client**      | Four low-level credential constructors **plus high-level `pay(url, { wallet, policy })`** — express an intent (gasless / token / cap) and the SDK auto-selects the route ([ADR-0003](docs/adr/0003-payment-offer-layer.md) Phase 1) |
| **Challenge binding** | `mppx-managed` (under `Mppx.create`), `mppx-hmac` (bare verify), `stored-lookup` (draft §6 zero-deviation)                                                                                                                          |
| **Settlement**        | Server-side broadcast for `permit2` / `authorization` (settlement signer pays gas); payer-broadcast for `hash` / `transaction`                                                                                                      |
| **Tokens / chains**   | Curated `(chain, token)` matrix — see [Tokens](#tokens) / [Chains](#chains)                                                                                                                                                         |
| **Receipt**           | `draft §7.6` `Payment-Receipt` via a browser-safe codec (`buildEvmReceipt` / `serializeEvmReceipt`)                                                                                                                                 |
| **Replay protection** | 3-state atomic store (inflight / consumed / rejected); durable backend required in production                                                                                                                                       |

All four credential paths are live end-to-end (see `examples/charge-server` + `examples/charge-demo`). For the full picture see [`docs/`](docs/) — architecture, spec compliance / extensions, replay store, and example walkthroughs. Release notes are managed with [Changesets](https://github.com/changesets/changesets) (`.changeset/`); `CHANGELOG.md` is generated at publish time — see [`docs/releasing.md`](docs/releasing.md) for the release pipeline.

v1 limits: curated token presets only (no arbitrary BYO ERC-20), and the SDK adds one spec extension (`methodDetails.permit2Spender`) that `draft-evm-charge-00` doesn't define but Permit2 settlement requires — see [`docs/spec-compliance.md`](docs/spec-compliance.md).

**Beyond the mppx charge flow**, the SDK also speaks **x402 v2**: `@bnb-chain/mpp/b402` (+ `/server`) integrates the [Binance OnchainPay (b402)](https://developers.binance.com/docs/onchainpay-x402/introduction) facilitator. Use it standalone (a parallel x402 envelope, sharing only the EIP-3009 EIP-712 primitive) **or** as an mppx settlement backend — `B402Adapter` keeps your buyers on the mppx wire and just delegates the EIP-3009 settle to b402. The Node `client-demo` (`start:pay`) pays a `merchant-demo` mode-3 server end-to-end over b402; the `charge-demo` browser app's BSC Testnet `$U` tab demonstrates the buyer-side EIP-3009 signing — see [`docs/b402.md`](docs/b402.md).

## Install

```bash
pnpm add @bnb-chain/mpp mppx viem
```

Peers: `mppx ^0.6.28`, `viem ^2.51.0`. Node ≥ 22 (development uses Node 22 stable).

## Quickstart

> For a full end-to-end walkthrough — server route + client credential +
> receipt, runnable on BSC Testnet — see [`docs/quickstart.md`](docs/quickstart.md).

```ts
import { Mppx } from 'mppx/server'
import { chargeAsync } from '@bnb-chain/mpp/server'
import { privateKeyToAccount } from 'viem/accounts'
import { createRedisReplayStore } from './your-replay-store-adapter' // see § "Replay store" below

const settlement = privateKeyToAccount(process.env.SETTLEMENT_PRIVATE_KEY as `0x${string}`)

const handler = Mppx.create({
  methods: [
    await chargeAsync({
      chain: 'ethereum',
      token: 'USDC',
      recipient: '0xYourMerchantAddress',
      credentialTypes: ['permit2', 'transaction', 'hash'],
      settlementAccount: settlement,
      challengeBinding: { mode: 'mppx-managed' },
      // Replay store — REQUIRED in production. See § "Replay store" below
      // for what counts as a durable atomic store and the dev-only default.
      store: createRedisReplayStore({ url: process.env.REDIS_URL! }),
    }),
  ],
  secretKey: process.env.MPPX_SECRET_KEY!,
  // No `transport` here — chargeAsync() factory auto-wires evmHttpTransport
  // on the per-method transport slot (spec §13.4.1 C2 auto-wire).
})

// Wire into your HTTP server (Hono / Express / Next.js — see mppx docs).
```

### Replay store

`params.store` is the **replay store** — the durable atomic backend that
guarantees a given credential settles at most once (`reserve` → settle →
`markConsumed`). It is independent of `challengeBinding`: the same store
backs `mppx-managed`, `mppx-hmac`, and `stored-lookup` modes. Spec §9 +
[draft-evm-charge-00](https://paymentauth.org/draft-evm-charge-00.html)
both require:

1. The store MUST be **durable across processes / pods** — a single Node
   process Map is not enough on multi-pod deployments (replay protection
   silently becomes per-pod, allowing N concurrent settlements of the
   same credential).
2. The reserve / mark-consumed transitions MUST be **atomic** — `reserve`
   under a key that's already `consumed` MUST fail without racing.

What the SDK enforces and what it doesn't:

- **`NODE_ENV=production` + `params.store` omitted** → `preflightCharge`
  throws at startup. Production deployments MUST pass a store explicitly.
- **`NODE_ENV=production` + any `params.store`** → accepted on presence
  alone. The SDK can't structurally tell a Redis client from a Map
  wrapper across the FFI boundary, so durability is a deployment-side
  claim. Honoring spec §9 is on you; the SDK just makes sure you
  remembered to wire something.
- **`NODE_ENV=development` / unset + omitted** → defaults to
  `Store.memory()` (mppx in-process) with a one-time `console.warn`,
  so the gap is visible before any production cutover.
- **`NODE_ENV=test` + omitted** → silent default to memory (no log noise
  in `vitest` / `vp test` runs).

Suggested durable backends:

- **Redis** — `SET key value NX` for atomic reserve; works on
  Upstash, AWS ElastiCache, self-hosted. Do NOT attach a backend TTL
  (`PX` / `EXPIRE`) — terminal slots must never expire, and stale
  `inflight` slots are reclaimed by `reserve()` itself (see
  [`docs/replay-store.md`](docs/replay-store.md)).
- **Postgres** — `INSERT ... ON CONFLICT DO NOTHING` for atomic reserve;
  works on Neon, Supabase, RDS.
- **Cloudflare KV / DO** — `put` with `conditional-write` for KV, or
  Durable Objects' single-writer model for stronger consistency.

`Store.memory()` from mppx is acceptable **only** for tests and local
single-process development; it MUST NOT back a production deployment
regardless of how many replicas are running (spec §9).

For routes that take human-readable amounts, the top-level barrel exports `chargeFromDecimal`:

```ts
import { chargeFromDecimal } from '@bnb-chain/mpp'

const request = chargeFromDecimal({ amount: '1.50', decimals: 6 })
// -> { amount: '1500000' }
```

## Spec Compliance

This SDK implements [`draft-evm-charge-00`](https://paymentauth.org/draft-evm-charge-00.html) layered on `mppx@0.6.28` (commit [`5aed74b`](https://github.com/wevm/mppx/tree/5aed74bfe46315ff3f27524ea8bb72e251bf771d)). The compliance choices + the one spec extension are summarized below; full detail (incl. `permit2Spender`) lives in [`docs/spec-compliance.md`](docs/spec-compliance.md).

### 1. Challenge binding

This deployment uses the `challengeBinding.mode` configured on `ServerParameters`. Three modes are supported:

- `'mppx-managed'` — Compose with `Mppx.create()`'s HTTP entry. mppx automatically runs `Challenge.verify` + `Expires.assert`; the SDK helper only enforces the `method='evm'` + `intent='charge'` guards.
- `'mppx-hmac'` — Bare `Method.toServer(...).verify` path. The SDK helper runs the full `Challenge.verify({ secretKey })` + `Expires.assert` chain because `Mppx.create()` is not in the pipeline. Use this for custom integrations.
- `'stored-lookup'` (draft §6 zero-deviation) — the deployment persists every issued challenge via `rememberChallenge(challengeStore, challenge)` at issuance time. On verify, the SDK helper re-derives the canonical wire form of each auth-param field from the inbound credential and constant-time compares against the stored snapshot. Standalone wrt HMAC — the deployment can run completely without a server secret. Production requires a durable `Store.AtomicStore<ChallengeItemMap>` backend (Redis / Postgres / Cloudflare KV); `Store.memory()` is test/dev only.

### 2. Receipt compatibility

```
draft-evm-charge-00 §7.6 requires EVM Charge receipts to include
`method`, `challengeId`, `reference`, `status`, `timestamp`, `chainId`,
and optionally `externalId`.

Current mppx `Receipt.Schema` does not preserve `challengeId` / `chainId`.
v1 ships a SDK-provided `evmHttpTransport` and the `charge(...)` / `chargeAsync(...)`
factory wires it on the per-method transport slot automatically — deployments
do NOT need to (and should not) configure `Mppx.create({ transport })` for
this. The resulting `Payment-Receipt` header preserves the full EVM Charge
receipt payload deterministically, independent of any future change to mppx
default `Receipt.serialize` behavior.
```

No deployment-side wiring is required — the Quickstart example deliberately
omits `transport` from `Mppx.create`.

### 3. v1 token support

```
v1 token support:
- v1 only supports curated token presets.
- Custom ERC-20 / BYO token is not supported in v1.
- `currency` on wire is always the resolved curated ERC-20 address.
- BYO token metadata, token registry input, EIP-3009 probing, and
  arbitrary ERC-20 support are future work.

Preset name semantics (hard rule):
- `USDC` preset means Circle native USDC only.
  BSC has no Circle native USDC; the curated matrix does NOT include
  (`bsc`, `USDC`). Binance-Peg USDC must not be represented as `USDC`
  in v1; if introduced later it must use a distinct preset name.
- Bridged / wrapped variants of `USDT`, `EURC`, `FDUSD`, `U` are
  subject to the same rule: do not reuse the native preset name.
- `FDUSD` preset means the First Digital Labs "First Digital USD"
  token (BSC mainnet `0xc5f0...6409`).
- `U` preset means the official "$U" / United Stables token (BSC
  mainnet `0xcE24...6666`). Symbol on-chain is the single letter `U`;
  the product name is "$U". The BSC testnet sibling deploy at
  `0x2Ae9...0a66` does NOT implement EIP-3009 (different deployment)
  and is intentionally absent from the matrix.
- `TEST_USDT` is a testnet-only preset. It MUST NOT appear in any
  mainnet curated matrix entry, and it MUST NOT be treated as Tether
  official mainnet `USDT`. Its contract addresses come from testnet
  deployments (mock / third-party / self-deployed) that have no
  official Tether provenance; do not rely on EIP-3009, decimals,
  or mint authority assumptions from mainnet `USDT`.
```

### 4. `permit2Spender` (spec extension)

`draft-evm-charge-00` does not define a `methodDetails.permit2Spender` field, but Permit2 settlement requires one: Permit2 hashes `msg.sender` (the on-chain caller) as the EIP-712 `spender`, so the payer must sign Permit2 typed data with the settlement signer's address or the on-chain `permitWitnessTransferFrom` reverts `InvalidSigner`. The SDK adds `permit2Spender` to `methodDetails` (OPTIONAL on the wire; REQUIRED for `permit2` credentials) and the server factory injects it automatically from `settlementAccount.address`. It affects only the `permit2` path — `hash` / `transaction` / `authorization` are unaffected. Full rationale + the verifier cross-check in [`docs/spec-compliance.md`](docs/spec-compliance.md) and [`docs/adr/0001-permit2-spender.md`](docs/adr/0001-permit2-spender.md).

## Tokens

The SDK ships a curated matrix — every `(chain, token)` pair lands alongside its explorer-verified address, on-chain `decimals()` confirmation, and matrix-lock unit tests (`src/server/curated.test.ts`). EIP-3009 entries additionally have their domain `name`/`version` derived from on-chain `DOMAIN_SEPARATOR()` and locked in the same test file. A newly added pair ships with `authorization` **off** (advertising `permit2` / `transaction` / `hash`) until that on-chain `transferWithAuthorization` + `DOMAIN_SEPARATOR()` probe confirms EIP-3009 support and the exact domain — inferring the domain from the token symbol would be a verification bug. Live settlement tests are added separately, alongside the corresponding test fixtures, and are gated under the `live` vitest project (see `test/live/*.live.test.ts`).

The table below lists the **EIP-3009-enabled** anchors (where the `authorization` path is live). Broader issuer-native stablecoin coverage (probe-gated, `authorization` off) is summarized under [Expanded coverage](#expanded-coverage).

| Chain       | Token            | Contract                                                                                           | Decimals | EIP-3009                                                                       |
| ----------- | ---------------- | -------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------ |
| ethereum    | USDC             | [`0xa0b8...eb48`](https://etherscan.io/address/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48)         | 6        | yes (Circle native, domain `USD Coin` / `2`)                                   |
| ethereum    | USDT             | [`0xdac1...1ec7`](https://etherscan.io/address/0xdac17f958d2ee523a2206206994597c13d831ec7)         | 6        | no                                                                             |
| base        | USDC             | [`0x8335...2913`](https://basescan.org/address/0x833589fcd6edb6e08f4c7c32d4f71b54bda02913)         | 6        | yes (Circle native, domain `USD Coin` / `2`)                                   |
| bsc         | BINANCE_PEG_USDT | [`0x55d3...7955`](https://bscscan.com/address/0x55d398326f99059ff775485246999027b3197955)          | 18       | no                                                                             |
| bsc         | FDUSD            | [`0xc5f0...6409`](https://bscscan.com/address/0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409)          | 18       | yes (First Digital Labs, domain `First Digital USD` / `1`)                     |
| bsc         | U                | [`0xcE24...6666`](https://bscscan.com/address/0xcE24439F2D9C6a2289F741120FE202248B666666)          | 18       | yes (United Stables `$U`, domain `United Stables` / `1`)                       |
| sepolia     | USDC             | [`0x1c7D...7238`](https://sepolia.etherscan.io/address/0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238) | 6        | yes (Circle native, domain `USDC` / `2`) — testnet, see `examples/charge-demo` |
| bsc-testnet | TEST_USDT        | [`0x3376...4dDd`](https://testnet.bscscan.com/address/0x337610d27c682E347C9cD60BD4b3b107C9d34dDd)  | 18       | no — testnet-only (PancakeSwap test USDT), see `examples/charge-server`        |

### Expanded coverage

Issuer-native stablecoins curated across the supported chains. These advertise `permit2` / `transaction` / `hash`; `authorization` (EIP-3009) is **off pending a per-chain probe** (see the note above). Contract addresses + decimals for every pair live in [`src/server/curated.ts`](src/server/curated.ts) and are locked by [`src/server/curated.test.ts`](src/server/curated.test.ts).

- **Circle USDC** — `arbitrum`, `optimism`, `polygon`, `avalanche`, `linea`, plus testnets `base-sepolia`, `arbitrum-sepolia`, `optimism-sepolia`, `polygon-amoy`, `avalanche-fuji`, `linea-sepolia`. Source: [Circle USDC addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses).
- **Circle EURC** — `ethereum`, `base`, `avalanche`, plus testnets `sepolia`, `base-sepolia`, `avalanche-fuji`. Source: [Circle EURC addresses](https://developers.circle.com/stablecoins/eurc-contract-addresses).
- **PayPal USD (PYUSD)** — `ethereum`, `arbitrum`, plus testnets `sepolia`, `arbitrum-sepolia`. Source: [Paxos PYUSD](https://docs.paxos.com/stablecoin/pyusd/mainnet).
- **Paxos USDP / USDG** — `ethereum`. Source: [Paxos USDP](https://docs.paxos.com/guides/stablecoin/usdp/mainnet) / [Paxos USDG](https://docs.paxos.com/stablecoin/usdg/mainnet).
- **First Digital USD (FDUSD)** — `ethereum`, `arbitrum` (plus the existing `bsc` entry, which is EIP-3009-probed). Source: [First Digital Labs](https://www.firstdigitallabs.com/fdusd).
- **Tether USD₮** — `avalanche` only (issuer-native; bridged L2 USDT on Arbitrum/Optimism/Polygon is deliberately excluded). Source: [Tether supported protocols](https://tether.to/en/supported-protocols/).
- **BNB Chain (BSC)** — native EIP-3009 tokens `FDUSD` and `U` are in the table above. Bridged stablecoins use distinct `BINANCE_PEG_*` names so they never wear native-issuer semantics: `BINANCE_PEG_USDC` (`0x8AC7…580d`, **18 dec**, not Circle-native USDC's 6), `BINANCE_PEG_USDT` (BSC-USD, `0x55d3…7955`, 18 dec — migrated off the bare `USDT` alias, which now means native Tether only, e.g. Ethereum), and `BINANCE_PEG_DAI` (`0x1AF3…DBc3`, 18 dec) — all standard BEP-20, no EIP-3009.
- **opBNB** — deliberately **not** in the default matrix yet. Stablecoin provenance there (native vs bridged, exact addresses, decimals) must be cross-verified against the BNB Chain bridge/token list, opBNBScan verified-contract pages, and on-chain `decimals()` / `symbol()` / `name()` probes before any entry lands.

## Chains

| Preset                                                                      | chainId | Default confirmations | Notes        |
| --------------------------------------------------------------------------- | ------- | --------------------- | ------------ |
| ethereum                                                                    | 1       | 12                    |              |
| base                                                                        | 8453    | 1                     |              |
| arbitrum                                                                    | 42161   | 1                     |              |
| optimism                                                                    | 10      | 1                     |              |
| polygon                                                                     | 137     | 5                     | reorg buffer |
| avalanche                                                                   | 43114   | 1                     |              |
| linea                                                                       | 59144   | 1                     |              |
| bsc                                                                         | 56      | 3                     | reorg buffer |
| opbnb                                                                       | 204     | 1                     |              |
| sepolia / _-sepolia / _-amoy / avalanche-fuji / bsc-testnet / opbnb-testnet | various | 0                     | dev velocity |

The default confirmations depth is overridable via `ServerParameters.confirmations` and applies to the paths where core waits on-chain — the verification depth for `hash` / `transaction`, the `permit2` settlement, and `authorization` settled by the **local signer**. It does **not** apply to `authorization` settled by a facilitator backend (b402), which trusts the facilitator's `success` + tx hash and does not re-fetch the receipt (see [`docs/b402.md`](docs/b402.md) trust model). Two related `ServerParameters` knobs: `settlementTimeoutMs` caps how long the settling verifiers hold the HTTP request open waiting for the settlement receipt (unset → viem's 180 s default; set it below your load balancer's idle timeout), and `inflightTtlMs` sets the age after which a stale `inflight` replay slot becomes reclaimable by a retry (default 10 min; keep it comfortably above `settlementTimeoutMs` — see [`docs/replay-store.md`](docs/replay-store.md)).

Permit2 deployment is auto-probed at `preflightCharge` time via `eth_getCode` against the resolved address. v1 does not open arbitrary BYO chain — `rpcUrl` and `chainOverride` may only override an existing preset's RPC / viem `Chain` metadata.

## Scripts

```bash
pnpm install        # via corepack, pnpm@11.0.8
pnpm check          # vp lint --fix + vp fmt --write
pnpm check:ci       # vp lint + vp fmt --check
pnpm check:types    # tsgo -b + tsgo -p tsconfig.test.json + example workspaces
pnpm test           # vp test --config vite.config.ts (unit + interop + live)
pnpm build          # zile -> dist/

# Vitest projects: pass flags through with `--` so pnpm doesn't
# intercept them as its own options.
pnpm test -- --project unit       # source + test/unit
pnpm test -- --project interop    # cross-impl / wire compat
pnpm test -- --project live       # gated on testnet RPC + signing keys
```

## License

MIT
