# @bnb-chain/b402

## 0.2.0

### Minor Changes

- 7cad29f: Security (audit H02): add replay/idempotency protection to every B402 settlement path. A resubmitted credential — client retry, duplicate request, or deliberate replay — can no longer settle more than once.
  - `@bnb-chain/b402/server` gains a three-state replay guard (`reserveB402Slot` / `markB402Consumed` / `markB402Rejected` / `releaseB402Slot`, plus `b402ReplayKey`) keyed on `(transferMethod, network, asset, payer, nonce)`, with fencing tokens, stale-inflight TTL reclaim, and write-once terminal states. The store contract is structural — mppx `Store.memory()` / `Store.redis(...)` satisfy it directly.
  - BREAKING: `@bnb-chain/mpp-b402`'s `charge()` now REQUIRES a `store` parameter. The verify hook reserves the slot before the facilitator's verify/settle run; an ambiguous settlement (`B402SettlementUnknownError`) keeps the slot blocking retries until the `inflightTtlMs` reconciliation window (default 10 min) elapses.
  - `B402FacilitatorClient` and `createB402Facilitator` accept an optional `store` guarding `settle()`, and warn at construction when omitted.

  Production deployments MUST pass a durable atomic store shared by all instances; `Store.memory()` guards a single process only.

- 59daa60: Security (audit L01–L05, I01–I06): Low/Informational hardening wave.
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

- ce11c16: Security (audit M01, M02, M03, M04, M05): five Medium-severity hardening fixes.
  - **M01** — `pay()` and `createPermit2Credential` now check the canonical Permit2 deployment address BEFORE the one-time unlimited `approve` broadcasts, and THROW by default (was a post-approve `console.warn`). A tampered `permit2Address` pointing at an attacker contract no longer costs the buyer an approve. Opt back with `allowNonCanonicalPermit2: true` for genuine fork/mirror deployments.
  - **M02** — `createPermit2Credential` now REQUIRES a non-empty `trustedSpenders` allowlist (BREAKING), and `pay()`'s `PayPolicy` gains `trustedPermit2Spenders` — permit2 routes are excluded from selection when it's unset or the challenge's `permit2Spender` isn't listed. Mirrors `@bnb-chain/b402`'s existing ADR-0004 model: a Permit2 signature covers `spender` but not the recipient, so an unvetted spender is a direct token-theft instrument.
  - **M03** — `B402Client` now enforces `https://` on `baseUrl` at construction (BREAKING for http:// configs; loopback hosts exempt for local dev). The `/settle` response is the sole evidence of settlement success and B402 does not sign responses, so plain http would let a network attacker forge "payment received". (Upstream OnchainPay has no documented response-signature mechanism, so application-layer response verification is deferred — see audit M03 status.)
  - **M04** — added `maxLength` caps to the wire schema (`src/Methods.ts`): 78 digits for decimal uint256 fields (amount/value/nonce/deadline/validAfter/validBefore), 128 KB for the raw `transaction` signature. Reordered `ChallengeBinding` checks so the cheap expiry / id-existence checks run before the expensive canonicalize+HMAC step. Closes an unauthenticated single-request CPU-exhaustion DoS via `BigInt()` / `parseTransaction` on unbounded input.
  - **M05** — `@bnb-chain/mpp-b402`'s `maxAmount` ceiling now converts using the buyer's own `allowedCurrencies[].decimals` and refuses to pay (fail closed) when it's absent, instead of trusting the merchant-declared `methodDetails.decimals` (which could inflate the ceiling ~10^12× and bypass the limit). Prefer `maxAtomicAmount` where possible.

## 0.1.1

### Patch Changes

- f1ac8be: Accept smart-account (ERC-1271/ERC-7739) signatures on the permit2-exact
  path. The B402 facilitator has validated such signatures on-chain via the
  payer contract's `isValidSignature()` on its permit2 rails since 2026-08,
  but the client rejected them before any network call: `isPermit2PaymentPayload`
  pinned the signature to exactly 65 bytes, and `B402FacilitatorClient`'s
  payment reconstruction unconditionally ecrecovered the payer — impossible
  for envelopes without a recoverable key (session-key wallets such as Altana,
  ERC-4337 accounts sign ~98-byte envelopes).
  - `isPermit2PaymentPayload` now accepts any 0x-prefixed even-length signature
    of 65 bytes or more; everything else it enforces (including the cross-field
    equalities) is unchanged.
  - `B402FacilitatorClient` branches on the signature length: 65-byte EOA
    signatures keep the exact local recover-and-compare gate; longer envelopes
    are forwarded with the declared `permit2Authorization.from` as the payer
    claim, and `verify()` cross-checks the facilitator-reported payer against
    that claim.
  - The eip3009 path is intentionally unchanged (the facilitator only accepts
    EOA signatures there), as is `buildPermit2ExactPayment` (an EOA signer).

  Backwards compatible: all existing EOA behavior and every local guard are
  untouched; the change only stops rejecting payments the facilitator accepts.

## 0.1.0

### Minor Changes

- c2e9b06: Extract B402 into `@bnb-chain/b402`, a provider Module that can be used directly
  with the official x402 SDK. Add x402 client/resource-server Scheme Adapters for
  EIP-3009 and Permit2 Exact, an authenticated FacilitatorClient Adapter, shared
  provider snapshot caching, runtime response validation, and typed
  unknown-settlement handoff.

  Publish the MPP `b402/charge` Method separately as `@bnb-chain/mpp-b402`. Both
  proofs bind their nonce to the MPP Challenge. Permit2 approval remains an
  explicit application action and spender allowlisting is required on both x402
  and MPP clients.

  Remove the B402 subpaths from `@bnb-chain/mpp`; its generic EVM Charge
  functionality is unchanged. No standalone Gate or buyer HTTP orchestrator is
  introduced. Permit2 Upto remains unsupported.

## 0.1.0

- Extract the B402 provider Module from `@bnb-chain/mpp`.
- Add official x402 client, resource-server, and facilitator Adapters.
