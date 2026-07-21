---
'@bnb-chain/mpp': minor
---

Redesign B402 as an MPP provider extension. Add the shared `b402/charge` Method,
browser-safe buyer Implementation, and merchant Implementation for B402
EIP-3009 and Permit2 Exact. Both proofs bind their nonce to the MPP Challenge;
the merchant reconstructs provider requests from authoritative values, validates
provider responses at runtime, and exposes typed unknown-settlement handoff
without owning application order storage.

Add `createB402Facilitator()` for standard mppx EIP-3009 x402 integration and a
TTL-bounded `/supported` cache. The asynchronous merchant factory validates
provider capabilities before route construction. Permit2 approval remains an
explicit application action and spender allowlisting is required.

Remove the standalone B402 Gate, buyer HTTP orchestrator, and `/b402/mppx`
entry point. B402 Permit2 Exact is available through `b402/charge`; Permit2
Upto remains unsupported. Existing generic EVM Charge functionality is
unchanged.

Align EVM Charge Permit2 with the July 2026 draft by signing and verifying
`PaymentWitness.externalId` (empty string when omitted), upgrade the validated
runtime baseline to mppx 0.8.12 and viem 2.54+, use mppx's standard loose-receipt
transport path, and narrow the B402 public wire surface to exact EIP-3009 and
permit2-exact only.
