# @bnb-chain/mpp-b402

## 0.1.1

### Patch Changes

- 520e614: Publish the refactored MPP B402 server Adapter with focused Provider snapshot, payment reconstruction, and Receipt mapping modules. The public API and `b402/charge` wire contract are unchanged.

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

### Patch Changes

- Updated dependencies [c2e9b06]
  - @bnb-chain/b402@0.1.0

## 0.1.0

- Publish B402 EIP-3009 and Permit2 Exact as an MPP custom payment method.
