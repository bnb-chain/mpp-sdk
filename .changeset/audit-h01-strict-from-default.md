---
'@bnb-chain/mpp': minor
---

Security (audit H01): the hash verifier's `hashFromPolicy` now defaults to `'strict_from'` — a hash credential must carry a `source` DID matching the on-chain `Transfer.from`, so a bystander can no longer claim a payer's transaction by racing its hash to the server (zero-cost order sniping). The `pay()` client automatically binds `source` to the paying account, so SDK-to-SDK flows keep working unchanged.

BREAKING for: (1) third-party clients submitting hash credentials without `source` — they must add it (DID PKH of the tx sender); (2) merchants whose payers send from addresses they don't control (exchange withdrawals, custodial wallets) — opt back with `hashFromPolicy: 'lax_from'`, accepting the sniping risk.

Residual risk (documented in docs/spec-compliance.md): `source` is self-declared and unsigned, so `strict_from` stops passive hash-sniping but not an attacker who also copies the payer's address. Merchants selling fixed-price repeatable goods should consider omitting `'hash'` from `credentialTypes` entirely.
