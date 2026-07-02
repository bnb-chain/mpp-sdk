---
'@bnb-chain/mpp': minor
---

Add b402 (x402 v2) facilitator support and a high-level buyer entry.

- **b402 / Binance OnchainPay** — new `@bnb-chain/mpp/b402` (+ `/server`, `/mppx`)
  entry points. `b402` (wire) and `b402/server` (RSA-signed client) stay
  core-free; `B402Adapter` (from `@bnb-chain/mpp/b402/mppx`) plugs into the
  server `settleBackend` seam so an EIP-3009 `authorization` credential can be
  settled by the b402 facilitator (it broadcasts + pays gas) without changing
  buyers — they keep speaking the same mppx wire. See `docs/b402.md` and
  `docs/adr/0002-settle-adapter.md`.

- **`SettleAdapter` seam** — `@bnb-chain/mpp/server` exposes a pluggable
  settlement backend (`LocalSignerAdapter` default; facilitator adapters such
  as `B402Adapter`) with a `SettleProof` discriminated union the verifier
  judges. Additive; existing local-signer settlement is unchanged.

- **High-level buyer `pay(url, { wallet, policy })`** — `@bnb-chain/mpp/client`
  now ships a unified buyer surface (ADR-0003 Phase 1) over the four mpp
  credentials. It fetches the 402, derives the offered routes, filters by a
  `policy` (token / chain / `maxAmount` / wallet capability / approval), and
  ranks by an intent `mode` (auto, prefer/require-gasless, prefer-direct,
  manual). It fails closed — `NoAcceptableMethodError` when nothing satisfies
  the policy, `PaymentRejectedError` when the server rejects the retry, and it
  refuses a wallet on the wrong chain unless `allowChainMismatch`.

- **b402 Permit2 (`permit2-exact`) on the standalone x402 wire** (ADR-0004) —
  `@bnb-chain/mpp/b402` adds the `Permit2EvmPayload` payload variant plus
  `buildPermit2ExactPayment` / `recoverPermit2ExactPayer` /
  `isPermit2PaymentPayload` / `B402_PERMIT2_ADDRESS` / `CURATED_B402_SPENDERS`.
  Fail-closed by design: the builder REQUIRES an explicit `trustedSpenders`
  allowlist (a 402's spender is attacker-controllable — buyers cannot call the
  RSA-gated `/supported`), constructs the witness itself from the offer's
  `payTo`, pins `permitted.amount` 1:1, and caps the deadline.
  `permit2-upto` is deliberately not modeled (undocumented witness).

- **One-call merchant/server helpers** — `createX402Gate`
  (`@bnb-chain/mpp/b402/server`): the whole standalone-x402 permit2-exact
  resource lifecycle behind one framework-agnostic gate (402 `accepts[]` menu,
  full-shape `X-PAYMENT` validation, offer pinning, reconstructed-payload
  forwarding, `/verify` → `/settle`, `X-PAYMENT-RESPONSE`); `B402Client.fromEnv`
  (all-or-nothing `B402_*` env loading — a partial config throws instead of
  silently changing settlement semantics); `b402ChargeParams`
  (`@bnb-chain/mpp/b402/mppx`): the b402-settled `ServerParameters` in one
  call. See the rewritten minimal integration guide in `docs/b402.md`.

- **Curated matrix** — `('bsc-testnet', 'U')` now pins
  `0xC70b8741…5565` (EIP-712 domain `United Stables`/`1` verified via
  `DOMAIN_SEPARATOR` reconstruction; public reads) instead of the
  facilitator-gated `0x180B…6A49` deployment.
