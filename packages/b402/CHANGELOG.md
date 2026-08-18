# @bnb-chain/b402

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
