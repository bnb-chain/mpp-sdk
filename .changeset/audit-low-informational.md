---
'@bnb-chain/mpp': minor
'@bnb-chain/b402': minor
'@bnb-chain/mpp-b402': minor
---

Security (audit L01–L05, I01–I06): Low/Informational hardening wave.

- **L02** — buyer-submitted `credential.source` is JSON.stringify-escaped before reaching rejection messages and the replay store (log-injection guard), matching the existing `externalId` handling.
- **L03** — new buyer-side `maxSettlementSeconds` hard ceiling (default 24h) on EIP-3009 `validBefore` and Permit2 `deadline` in `@bnb-chain/b402` (`buildEip3009Payment` / `buildPermit2ExactPayment`, exported `DEFAULT_MAX_SETTLEMENT_SEC`) and `@bnb-chain/mpp-b402`'s client. A tampered challenge declaring a 100-year `maxTimeoutSeconds` can no longer mint a long-lived "zombie authorization".
- **L04** — `mpp-b402`'s `stableBinding` now pins `signerAddress`/`spenderAddress` into the challenge HMAC, making the ProviderSnapshot doc's tamper-evidence claim actually true. NOTE: challenges issued before this deploy fail verification after it (in-flight window self-heals on re-challenge).
- **L05 (BREAKING)** — `preflightCharge` now REQUIRES `params.store` regardless of NODE_ENV; the in-process memory fallback needs an explicit `allowMemoryStore: true` (NODE_ENV=test keeps the silent default). Previously any NODE_ENV other than the literal `'production'` (including unset) silently degraded to a per-process store, voiding double-spend protection behind a load balancer.
- **I01** — re-enabled `trustPolicy: no-downgrade` in pnpm-workspace.yaml (lockfile pinned & vetted).
- **I02 / L01** — new "Deployment hardening" docs in docs/replay-store.md: rate-limiting guidance for the zero-cost `hash`/`transaction` submission paths (RPC-amplification table for all four credential types) and stored-lookup challenge-store sweep/TTL guidance.
- **I03** — `pay()` refuses non-loopback `http://` targets by default (`allowInsecureUrl: true` to override).
- **I04** — an explicit `methodDetails: null` route option now rejects with a typed `InvalidChallengeError` instead of a raw TypeError.
- **I05** — `parseSupportedResponse` uses a null-prototype accumulator and rejects `__proto__`/`constructor`/`prototype` network keys (single-object prototype-confusion guard).
- **I06** — `recoverEip3009Payer` normalizes 64-byte EIP-2098 compact signatures to 65-byte form before recovery, so legitimate compact-signature payers are no longer rejected as malformed.
