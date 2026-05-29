---
'@bnb-chain/mpp': minor
---

Phase A-E spec §15 DoD completion:

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
