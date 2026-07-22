# ADR-0006: Split the B402 Provider Module from protocol Adapters

- Status: Accepted
- Date: 2026-07-22
- Supersedes: the package-locality decision in [ADR-0005](0005-b402-provider-extension.md)

## Context

ADR-0005 kept B402 under `@bnb-chain/mpp` because MPP was its only consumer.
The official x402 SDK is now a second consumer. Keeping RSA transport, provider
snapshots, proof validation and settlement classification inside an MPP package
would either prevent direct x402 use or duplicate trust-critical behavior.

Two Adapters prove a real Seam. Applying the deletion test to the Provider
Module also shows Depth: removing it recreates the same security complexity in
both callers.

## Decision

Publish three packages with one-way dependencies:

- `@bnb-chain/mpp`: generic EVM Charge only;
- `@bnb-chain/b402`: B402 Provider Module plus official x402 Adapters;
- `@bnb-chain/mpp-b402`: MPP `b402/charge` Adapter backed by
  `@bnb-chain/b402`.

`@bnb-chain/b402` implements the official x402 `FacilitatorClient`,
`SchemeNetworkClient`, and `SchemeNetworkServer` Interfaces. Official x402
transport packages continue to own HTTP headers, retries and route lifecycle.
No custom Gate or buyer fetch orchestrator is restored.

The MPP Adapter continues to own Challenge-bound nonces, Credential framing and
Receipt mapping. Direct x402 uses fresh x402 nonces. Permit2 Exact retains its
B402-specific proxy and witness; no translation to generic MPP Permit2 occurs.

Provider settlement classification remains in one Implementation. Failed
settlements carrying transaction evidence are unknown, never unpaid.

## Consequences

- Direct x402 and MPP receive the same provider safety invariants.
- `@bnb-chain/mpp` has no B402 dependency or exports.
- The old `@bnb-chain/mpp/b402*` subpaths are removed. A forwarding layer was
  rejected because it would force the generic package to depend on both new
  B402 packages and defeat the split.
- Applications migrate provider imports to `@bnb-chain/b402` and MPP Method
  imports to `@bnb-chain/mpp-b402`.
- npm Trusted Publishing must be configured for both new packages.
