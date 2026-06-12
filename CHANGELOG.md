# @bnb-chain/mpp

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
