---
'@bnb-chain/mpp': minor
---

PR2 — Hash credential verifier (`verifyHash`, spec §8.4) live: 8-step
algorithm with per-step replay-state transitions (reserve / release /
markRejected / markConsumed). Default `hashFromPolicy: 'lax_from'`
follows draft §6.4 (token/recipient/value triple); `'strict_from'`
optionally requires `credential.source` and verifies `Transfer.from`.

PR2 also ships the `'stored-lookup'` challenge binding mode (draft §6
zero-deviation). New `ChallengeStore` (`Store.AtomicStore<ChallengeItemMap>`)
with `rememberChallenge` / `lookupChallenge` / `forgetChallenge` helpers
and `canonicalizeChallenge`. Verification re-derives the canonical wire
form of each auth-param from the inbound credential and constant-time
compares against the stored snapshot via `node:crypto.timingSafeEqual`.
Standalone wrt HMAC — deployments can run without a server secret.
