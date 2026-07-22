# @bnb-chain/mpp

## 0.5.0

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

## 0.4.0

### Minor Changes

- 6c20c5f: Publish B402 as an MPP-native provider extension. Add the shared `b402/charge`
  Method, browser-safe buyer Implementation, and merchant Implementation for B402
  EIP-3009 and Permit2 Exact. Both proofs bind their nonce to the MPP Challenge;
  the merchant reconstructs provider requests from authoritative values, validates
  provider responses at runtime, and exposes typed unknown-settlement handoff.
  Failed facilitator responses carrying transaction evidence remain unknown until
  the host reconciles their on-chain outcome; only failures with an empty
  transaction are definitive pre-broadcast rejections.

  Add `createB402Facilitator()` for standard mppx EIP-3009 x402 integration and a
  TTL-bounded `/supported` cache. Permit2 approval remains an explicit application
  action and spender allowlisting is required.

  Remove the standalone B402 Gate, buyer HTTP orchestrator, and `/b402/mppx` entry
  point. B402 Permit2 Exact is available through `b402/charge`; Permit2 Upto
  remains unsupported. Existing generic EVM Charge functionality is unchanged.

## 0.3.0

### Minor Changes

- a348c6a: Harden the B402 response and x402 Permit2 boundaries: validate facilitator
  responses at runtime, pin and reconstruct every server-owned requirement,
  cross-check verify/settle payers, expose structured unknown-settlement context,
  add a TTL-bounded shared `/supported` cache, and add explicit fixed/dynamic
  Permit2 Exact Gate names while preserving `createX402Gate` as an alias. Add a
  cohesive B402 Exact extension for both EIP-3009 and Permit2 Exact, plus a
  high-level buyer client that keeps Permit2 approval explicit and fails before
  signing when allowance is insufficient.

  Align EVM Charge Permit2 with the July 2026 draft by signing and verifying
  `PaymentWitness.externalId` (empty string when omitted), upgrade the validated
  runtime baseline to mppx 0.8.12 and viem 2.54+, use mppx's standard loose-receipt
  transport path, and narrow the B402 public wire surface to exact EIP-3009 and
  permit2-exact only.

## 0.2.0

### Minor Changes

- 0fdef74: Add b402 (x402 v2) facilitator support and a high-level buyer entry.
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

## 0.1.0

### Minor Changes

- bd15919: PR1 Foundation — schema, wire layer, receipt codec (C2 path), challenge
  binding (`mppx-managed` + `mppx-hmac`), three-state replay store,
  settlement signer resolution, and the `preflightCharge` + `charge`
  factory pair. Credential verifier bodies stubbed pending PR2-5.
- bd15919: Phase A-E spec §15 DoD completion:
  - **Client-side credential constructors** (`@bnb-chain/mpp/client`):
    `createHashCredential`, `createTransactionCredential`,
    `createPermit2Credential` (single + batch with splits),
    `createAuthorizationCredential`. Each returns the serialized
    credential string ready for the `Authorization: Payment ...` header.
    Round-trip tests cover unit + handler.verifyCredential acceptance.

  - **§14.5.1.2 PR2-5 integration tests** — every credential type's
    verifier is exercised end-to-end through real Mppx.create handler +
    handler.verifyCredential, with stub publicClient + WalletClient
    keeping tests offline.

  - **§14.4 viem cross-check** (`test/interop/ViemCrossCheck.test.ts`):
    EIP-712 typed-data hash for Permit2 single / batch + EIP-3009
    computed via SDK exports AND a fully inlined no-imports re-definition
    — both fed to viem.hashTypedData. Hashes must match byte-for-byte;
    drift in our typed-data exports surfaces here. Plus sign + recover
    round-trip per type + a negative drift detector.

  - **§14.7 concurrent double-spend** (`src/server/Replay.concurrent.test.ts`):
    N=50 parallel reserve()s on the same key → exactly 1 winner; N=10
    parallel verifyHash on same txHash → exactly 1 receipt + N-1
    VerificationFailedError; final slot state 'consumed'.

  - **Live e2e scaffolds**: `test/live/BscTestnet.live.test.ts` and
    `test/live/OpBnbTestnet.live.test.ts` with 16 `it.todo` placeholders
    - file-header instructions for gating (TEST_USDT contract pinning +
      RPC + signing key env vars).

  - **CI workflow**: `.github/workflows/verify.yml` + composite
    `.github/actions/install-dependencies/action.yml`. Runs lint+fmt,
    type-check, unit+interop tests, and zile build in parallel on push +
    PR. Live project excluded — requires testnet RPC + keys.

- bd15919: PR2 — Hash credential verifier (`verifyHash`, spec §8.4) live: 8-step
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

- bd15919: PR3 — Transaction credential verifier (`verifyTransaction`, spec §8.3)
  live: 16-step algorithm. Local validation (steps 1-8) parses the raw
  EIP-1559 transaction, asserts type / chainId / `to` / `value=0` / data
  selector / decoded transfer args strictly match the request, and
  recovers the sender. Replay slot is only reserved AFTER local checks
  pass (step 10). Broadcast (step 11) categorizes node errors: definitely-
  rejected (invalid signature / fee / chainId mismatch / malformed RLP)
  release the slot, while possibly-accepted errors (already-known / nonce-
  too-low / underpriced replacement) check `getTransactionReceipt` + a
  mempool probe before releasing. Receipt assertions (steps 13-14) handle
  revert + Transfer-log mismatch with `markRejected`. Default
  `confirmations` comes from `curatedDefaultConfirmations(chain)`.
- bd15919: PR4 — Permit2 credential verifier (`verifyPermit2`, spec §8.1) live:
  19-step algorithm supporting both single-permit (no splits) and batch-
  permit (splits per draft §4.2.3) paths. Local validation (steps 2-11):
  deadline > now, length / token / amount / recipient / splits matching,
  `witness.challengeHash` matches `computeChallengeHash(challenge.id,
challenge.realm)`, EIP-712 typed-data recovery via
  `recoverTypedDataAddress`, and `credential.source` REQUIRED + must equal
  `did:pkh:eip155:<chainId>:<recoveredSigner>` per draft §6.1. On-chain
  (steps 12-19): atomic reserve on `permit2Key(chainId, permit2Address,
recoveredSigner, nonce)`, ERC-20 `balanceOf` + `allowance` checks,
  `simulateContract` pre-broadcast, `writeContract` via settlementSigner,
  `waitForTransactionReceipt`, strict ordered Transfer-log match against
  all `transferDetails[i].(to, requestedAmount)`. Replay semantics:
  pre-broadcast failures (balance / allowance / simulate / broadcast)
  release the slot (nonce unconsumed); post-success log mismatch is
  `markRejected` (nonce consumed on-chain — credential is unreplayable).
- bd15919: PR5 — EIP-3009 authorization credential verifier (`verifyAuthorization`,
  spec §8.2) live: 16-step algorithm. Local validation (steps 1-8):
  `payload.to` / `payload.value` / `payload.nonce` (derived via
  `eip3009Nonce`) match the challenge, `validBefore > now`,
  `validAfter <= now`, curated EIP-712 domain (tokenName + tokenVersion)
  is supplied via ctx (preflightCharge resolves via
  `getCuratedEip712Domain` only when `'authorization'` is in the
  resolved credential set), `recoverTypedDataAddress` recovers the signer,
  and `recoveredSigner === payload.from` (with optional
  `credential.source` lockstep). On-chain (steps 9-16): atomic reserve on
  `authKey(chainId, currency, recoveredSigner, payload.nonce)`,
  `balanceOf(from) >= value`, `parseSignature` splits into (v,r,s),
  simulate + write `transferWithAuthorization` via settlementSigner,
  `waitForTransactionReceipt`, strict Transfer-log match. Replay
  semantics: pre-success failures release the slot (nonce unconsumed),
  post-success log mismatch is `markRejected` (token consumed nonce on-chain).

  All four credential paths (hash, transaction, permit2, authorization)
  are now live; the PR1 `notImplemented` stub is removed from
  `src/server/Charge.ts`.

- bd15919: Add `bsc/FDUSD` (First Digital USD) and `bsc/U` ("$U" / United Stables)
  to the curated token matrix. Both are EIP-3009 capable on mainnet —
  domains derived by brute-forcing the on-chain `DOMAIN_SEPARATOR()`
  return value against EIP-712 candidates (2026-05-28 probes):
  - `bsc/FDUSD` — `0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409`, 18 decimals,
    EIP-712 domain `First Digital USD` / `1`.
  - `bsc/U` — `0xcE24439F2D9C6a2289F741120FE202248B666666`, 18 decimals,
    EIP-712 domain `United Stables` / `1`. Symbol on-chain is `U`; the
    product ships as "$U".

  Both expose the full credential type set: `authorization`, `permit2`,
  `transaction`, `hash`. `'U'` is added to `SupportedTokenPreset`.

  Note: the BSC testnet $U sibling at `0x2Ae938053c112Bd81042043945d142e208b50a66`
  does NOT implement EIP-3009 (different deployment); `('bsc-testnet', 'U')`
  is intentionally absent from the matrix and locked by a regression test.
