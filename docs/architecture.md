# Architecture

`@bnb-chain/mpp` is the EVM Charge (`draft-evm-charge-00`) implementation
layered on [`mppx`](https://github.com/wevm/mppx). It exposes four entry
points sharing one wire contract:

- `@bnb-chain/mpp` — top-level barrel (`chargeFromDecimal`, the receipt
  codec, the `chargeMethod` instance)
- `@bnb-chain/mpp/server` — `preflightCharge` / `charge` / `chargeAsync`
  server factory + the four credential verifiers
- `@bnb-chain/mpp/client` — the four credential constructors plus
  `pay(url, { wallet, policy })`, the high-level buyer entry that auto-selects
  a route by capability + policy (Phase 1 of the Payment Offer Layer,
  [adr/0003](adr/0003-payment-offer-layer.md); mpp-only today)
- `@bnb-chain/mpp/b402` (+ `/server`, `/mppx`) — the Binance OnchainPay (x402
  v2) facilitator integration: `b402` (wire) + `b402/server` (RSA-signed client)
  stay core-free; `b402/mppx` bridges b402 into the charge flow as a
  `SettleAdapter` ([b402 section](#b402-x402-facilitator) · [b402.md](b402.md))

The **single source of truth for the wire shape** is `src/Methods.ts`
(`chargeMethod` = a `Method.from({...})` instance). Server and client both
import it, so a wire-schema change is impossible to make on one side only.

## End-to-end data flow

```
        ┌─────────── server (@bnb-chain/mpp/server) ───────────┐
        │                                                       │
  preflightCharge(params)                                       │
        │  curated (chain,token) resolve → currency/decimals/   │
        │  chainId/permit2Address; Permit2 eth_getCode probe;   │
        │  settlement signer resolve; EIP-712 domain resolve    │
        ▼                                                        │
   charge(prepared) → Method.Server                             │
        │  defaults (incl. permit2Spender), request hook,       │
        │  stableBinding, verify router                         │
        ▼                                                        │
   Mppx.create({ methods:[...] }) → HTTP handler                │
        │                                                       │
        ▼                                                        │
   GET /resource (no credential)                                │
        └──────────────▶ 402 + WWW-Authenticate: Payment <challenge>
                                       │
        ┌────────── client (@bnb-chain/mpp/client) ─────────────┐
        │  Challenge.deserialize(header)                        │
        │  createXxxCredential({ challenge, account, ... })     │
        │    parseEvmChargeChallenge → accepted-type gate →     │
        │    per-field match → sign (EIP-712 / EIP-1559) /      │
        │    broadcast (hash)                                   │
        ▼                                                        │
   GET /resource  Authorization: Payment <credential>           │
        └──────────────▶ verify router (by payload.type)        │
                                       │                         │
        ┌─────────── verifier (per credential type) ────────────┐
        │  challenge binding check (mppx-managed/hmac/lookup)   │
        │  accepted-types gate → local checks → replay reserve  │
        │  → on-chain settle (permit2/auth) or correlate (hash) │
        │  → markConsumed → buildEvmReceipt                     │
        ▼                                                        │
   200 + Payment-Receipt: <serializeEvmReceipt(receipt)>        │
        └───────────────────────────────────────────────────────┘
```

## Layers

### Wire schema — `src/Methods.ts`

`chargeMethod.schema.request` is the zod-mini allowlist for the
challenge's `request` payload. `methodDetails` REQUIRED fields are
`chainId` + `permit2Address`; OPTIONAL are `permit2Spender`,
`credentialTypes`, `decimals`, `splits`. `credentialPayload` is a
discriminated union over `type` for the four credential shapes.

Anything REQUIRED here must be present at `schema.request.parse()` time —
the server factory injects defaults _before_ parse; it is never the
request hook's job to backfill REQUIRED fields.

### Server factory — `src/server/Charge.ts`

`preflightCharge(params)` resolves everything that needs I/O or curated
lookups up front:

- curated `(chain, token)` → `currency` / `decimals` / `chainId` /
  `permit2Address` (`src/server/curated.ts`)
- Permit2 deployment probe via `eth_getCode` (drops `permit2` from the
  accepted set if not deployed)
- settlement signer (`src/server/Settlement.ts`) — required iff
  `permit2` or `authorization` is in the resolved set
- EIP-712 domain (`name` / `version`) for `authorization` from the
  curated matrix
- replay store (presence-only check; durable backend is a deployment
  claim — see [replay-store.md](replay-store.md))

`charge(prepared)` builds the `Method.Server` with four hooks:

- **defaults** — every REQUIRED `methodDetails` field, plus
  `permit2Spender` (from the settlement signer's address) when a signer
  is configured
- **request hook** — route-override guard (§14.10): rejects any route
  option that tries to change a server-pinned field, and rejects partial
  `methodDetails` (mppx merges shallowly, so a partial would silently drop
  fields)
- **stableBinding** — augments mppx's default HMAC binding to cover the
  full `methodDetails` (mppx only pins `chainId` + `splits`)
- **verify** — challenge-binding check, then the accepted-types gate,
  then dispatch by `credential.payload.type` to the matching verifier

### Verifiers — `src/server/{Hash,Transaction,Permit2,Authorization}.ts`

Each verifier follows the same skeleton: cheap local checks (no I/O) →
replay-slot reserve → on-chain action → `markConsumed` → `buildEvmReceipt`.
The replay store is a 3-state CAS machine; see
[replay-store.md](replay-store.md) for the inflight/consumed/rejected
transitions and the terminal-commit phase that prevents double-spend.

- **hash** — correlate an existing on-chain `Transfer` log against the
  challenge (payer already broadcast)
- **transaction** — `sendRawTransaction` the payer's signed EIP-1559 RLP,
  then assert the receipt
- **permit2** — recover the EIP-712 signer, `permitWitnessTransferFrom`
  (single) / `permitBatchWitnessTransferFrom` (batch), assert all
  `Transfer` logs. The EIP-712 `spender` MUST equal the settlement signer
  — see [spec-compliance.md](spec-compliance.md) §`permit2Spender`.
- **authorization** — recover the EIP-3009 signer against the curated
  token domain, then settle via the configured `SettleAdapter` (see below):
  the local signer broadcasts `transferWithAuthorization` + asserts the
  `Transfer` log; a facilitator backend (b402) asserts the echoed
  `facilitator` proof instead

### Settlement adapters — `src/server/Settle.ts`

The `authorization` verifier's on-chain broadcast is pluggable via
`ServerParameters.settleBackend` (a `SettleAdapter`). The verifier keeps all
challenge binding, the replay 3-state machine, front-run recovery, the §7.6
receipt, **and the trust-critical check that the settled transfer matched the
signed authorization** — an adapter only delegates the broadcast and returns a
normalized `SettleReceipt` whose `proof` the verifier judges:

- **`LocalSignerAdapter`** (default — wired from `settlementAccount`) is the
  original `simulate → write → waitForReceipt`, relocated. Returns a `logs`
  proof; the verifier matches the authorized ERC-20 `Transfer`. Existing
  deployments are unchanged.
- **`B402Adapter`** (`@bnb-chain/mpp/b402/mppx`, the only b402 subpath that
  depends on core) forwards the EIP-3009 authorization to the Binance b402
  facilitator — no local signer, b402 pays gas. Returns a `facilitator` proof
  echoing the settled payer / network / amount; the verifier asserts they equal
  the authorized from / chainId / value before issuing the receipt.
  `SettlePendingError` keeps the slot inflight.

`SettleReceipt.proof` is a discriminated union (`logs` | `facilitator`), so the
two settlement modes can't represent each other's illegal states, and the
integrity check is applied uniformly in core rather than re-implemented per
adapter.

The buyer-facing mppx wire is unchanged — settlement is orthogonal to the
protocol. eip3009 only (permit2 settles locally); see
[adr/0002-settle-adapter.md](adr/0002-settle-adapter.md). A proposed
negotiation layer above the wire (one buyer `pay({ policy })`, many rails,
spec-clean) is sketched in
[adr/0003-payment-offer-layer.md](adr/0003-payment-offer-layer.md) (Proposed).

### Client constructors — `src/client/{Hash,Transaction,Permit2,Authorization}.ts`

Each `createXxxCredential` runs the shared challenge guards
(`src/client/internal/AssertChallenge.ts`): `parseEvmChargeChallenge`
(method/intent + schema parse) → `assertCredentialTypeAccepted` (the type
must be in the challenge's advertised set; default `['transaction','hash']`
when omitted) → `assertMatchesChallengeRequest` (caller fields must equal
wire truth) → sign / broadcast → `Credential.serialize` (returns the
complete `Payment ...` Authorization header value).

### Buyer auto-selector — `src/client/pay.ts`

`pay(url, { wallet, policy })` is the high-level entry layered over those
constructors. It fetches the 402, reads token facts off the viem clients
(symbol / decimals / allowance / chainId), then `deriveLogicalPaths`
turns `methodDetails.credentialTypes` into routes with derived traits and
`selectRoute` picks one: hard constraints (token / chain / `maxAmount` /
wallet capability / approval) **filter**, `mode`
(`auto | prefer-gasless | require-gasless | prefer-direct | manual`)
**ranks**, and an empty viable set throws `NoAcceptableMethodError` — the
fail-closed contract. The two pure functions are exported and exhaustively
unit-tested; `pay` itself is the fetch → derive → select → build → retry
wiring. Fail-closed in both directions: `policy.maxAmount` with
unresolvable decimals refuses rather than skips the limit, a wallet on the
wrong chain refuses unless `allowChainMismatch`, and a non-2xx retry raises
`PaymentRejectedError` instead of returning a result that looks settled.
This is Phase 1 of [adr/0003](adr/0003-payment-offer-layer.md) — mpp rails
only; the cross-rail (x402 / b402) selection is the future phase.

### Receipt codec — `src/server/Receipt.ts`

`buildEvmReceipt` / `serializeEvmReceipt` / `deserializeEvmReceipt`
implement the `draft §7.6` receipt (`method` / `challengeId` / `reference`
/ `status` / `timestamp` / `chainId` / optional `externalId`). The codec
is browser-safe (no Node `Buffer`) so the demo can round-trip it
client-side. mppx's default `Receipt.Schema` drops `challengeId` /
`chainId`, so the SDK ships its own `evmHttpTransport`
(`src/server/Transport.ts`) that `charge()` auto-wires on the per-method
transport slot — deployments never configure `Mppx.create({ transport })`.

## Challenge binding modes

`challengeBinding.mode` on `ServerParameters` selects how a credential's
embedded challenge is trusted (`src/server/ChallengeBinding.ts`):

- **mppx-managed** — under `Mppx.create`; mppx runs `Challenge.verify`
  HMAC + `Expires.assert` automatically. The SDK only adds the
  method/intent + route-binding guards.
- **mppx-hmac** — bare `Method.toServer(...).verify`; the SDK runs the
  full `Challenge.verify({ secretKey })` + `Expires.assert` itself.
- **stored-lookup** — no server secret; the deployment persists each
  issued challenge (`rememberChallenge`) and the verifier constant-time
  compares the inbound challenge's canonical wire form against the stored
  snapshot (`src/server/ChallengeStore.ts`).

## b402 (x402 facilitator)

`@bnb-chain/mpp/b402` integrates the Binance OnchainPay **b402** gateway — an
**x402 v2** facilitator. It is a deliberately _parallel_ module: it does not
touch the charge factory, verify router, replay store, challenge binding, or
receipt codec. The **only** shared seam is `src/protocol/TypedData.ts` (the
EIP-3009 `eip3009Types` / `eip3009Domain` primitive) — `src/b402/` imports it,
and nothing in the core imports `src/b402/`. The server-side `B402Client`
(RSA-signed `/supported` · `/verify` · `/settle`) is Node-only; the rest of the
module is browser-safe so a wallet can sign in the browser. Full guide:
[b402.md](b402.md).

## Source map

See [`AGENTS.md`](../AGENTS.md) for the file-by-file map and contributor
workflow rules.
