# ADR-0005: Model B402 as an MPP provider extension

- Status: Accepted
- Date: 2026-07-21
- Supersedes: the B402-specific decisions in ADR-0002, ADR-0003, and ADR-0004

## Context

The first B402 integration exposed a standalone x402 Gate, a buyer HTTP
orchestrator, and a settlement Adapter into this package's earlier custom EVM
engine. That produced two application protocols and duplicated responsibilities
already owned by `mppx`: Challenge/Credential/Receipt handling, HTTP transport,
method composition, retries, and hooks.

B402 has two Exact settlement proofs with different signed shapes:

- EIP-3009 `TransferWithAuthorization`;
- B402 `permit2-exact` `PermitWitnessTransferFrom`.

The standard `mppx` `evm/charge` x402 facilitator Interface models EIP-3009,
but it does not model B402's Permit2 proxy and witness contract.

## Decision

Keep `@bnb-chain/mpp` as a collection of payment methods and provider
extensions. B402 remains local to these subpaths:

- `@bnb-chain/mpp/b402` — shared wire contract and browser-safe B402 values;
- `@bnb-chain/mpp/b402/client` — wallet credential implementation;
- `@bnb-chain/mpp/b402/server` — merchant method, authenticated B402 client,
  and standard facilitator Adapter.

The primary integration is the custom MPP method `b402/charge`. It supports
both `eip3009` and `permit2-exact`, while `mppx` owns the outer MPP protocol.
Both proofs bind their nonce to `keccak256(challenge.id || challenge.realm)`.
The merchant Method factory is asynchronous so it can validate `/supported`
and seed mppx's synchronous canonical route before traffic is accepted.

`createB402Facilitator()` is a compatibility Adapter for the standard
`mppx` `evm/charge({ x402: { facilitator } })` Interface. It supports
EIP-3009 only. Permit2 Exact uses `b402/charge`; the Adapter must not translate
between incompatible witness formats.

The merchant reconstructs every B402 facilitator request from the HMAC-bound
MPP Challenge plus the parsed credential. Buyer-supplied `accepted`, resource,
or extension metadata is never forwarded. Bazaar metadata, when configured,
comes only from merchant configuration.

After `/settle` starts, a transport/parser failure or malformed success is an
unknown outcome. The SDK raises `B402SettlementUnknownError` and invokes
`onSettlementUnknown` with the exact reconstructed request. The host
application owns order state, durable persistence, and reconciliation.

## Rejected alternatives

- Keep a standalone `X-PAYMENT` Gate and buyer fetch loop in the SDK. This
  duplicates `mppx` transport and lifecycle behavior.
- Route B402 Permit2 through standard `evm/charge`. Its signed witness and
  provider proxy are not represented by that Interface.
- Add a provider-neutral facilitator framework now. With one provider, this
  would introduce abstractions without a second implementation to validate
  them. Provider code stays local until another provider demonstrates a shared
  Seam.
- Let the SDK own an order/reconciliation database. Storage and fulfillment
  policy belong to the merchant application.

## Consequences

- Existing generic EVM Charge functionality remains unchanged.
- Client and merchant integration use standard `mppx` composition and become
  substantially smaller.
- The removed `/b402/mppx`, Gate, and buyer-orchestrator APIs are breaking
  changes and require a major-version migration note.
- A future provider follows the same `/provider`, `/provider/client`, and
  `/provider/server` locality, but shared abstractions are extracted only when
  two implementations prove them.
