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
