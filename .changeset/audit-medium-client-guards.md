---
'@bnb-chain/mpp': minor
'@bnb-chain/mpp-b402': minor
'@bnb-chain/b402': minor
---

Security (audit M01, M02, M03, M04, M05): five Medium-severity hardening fixes.

- **M01** — `pay()` and `createPermit2Credential` now check the canonical Permit2 deployment address BEFORE the one-time unlimited `approve` broadcasts, and THROW by default (was a post-approve `console.warn`). A tampered `permit2Address` pointing at an attacker contract no longer costs the buyer an approve. Opt back with `allowNonCanonicalPermit2: true` for genuine fork/mirror deployments.
- **M02** — `createPermit2Credential` now REQUIRES a non-empty `trustedSpenders` allowlist (BREAKING), and `pay()`'s `PayPolicy` gains `trustedPermit2Spenders` — permit2 routes are excluded from selection when it's unset or the challenge's `permit2Spender` isn't listed. Mirrors `@bnb-chain/b402`'s existing ADR-0004 model: a Permit2 signature covers `spender` but not the recipient, so an unvetted spender is a direct token-theft instrument.
- **M03** — `B402Client` now enforces `https://` on `baseUrl` at construction (BREAKING for http:// configs; loopback hosts exempt for local dev). The `/settle` response is the sole evidence of settlement success and B402 does not sign responses, so plain http would let a network attacker forge "payment received". (Upstream OnchainPay has no documented response-signature mechanism, so application-layer response verification is deferred — see audit M03 status.)
- **M04** — added `maxLength` caps to the wire schema (`src/Methods.ts`): 78 digits for decimal uint256 fields (amount/value/nonce/deadline/validAfter/validBefore), 128 KB for the raw `transaction` signature. Reordered `ChallengeBinding` checks so the cheap expiry / id-existence checks run before the expensive canonicalize+HMAC step. Closes an unauthenticated single-request CPU-exhaustion DoS via `BigInt()` / `parseTransaction` on unbounded input.
- **M05** — `@bnb-chain/mpp-b402`'s `maxAmount` ceiling now converts using the buyer's own `allowedCurrencies[].decimals` and refuses to pay (fail closed) when it's absent, instead of trusting the merchant-declared `methodDetails.decimals` (which could inflate the ceiling ~10^12× and bypass the limit). Prefer `maxAtomicAmount` where possible.
