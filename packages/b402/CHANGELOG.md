# @bnb-chain/b402

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
