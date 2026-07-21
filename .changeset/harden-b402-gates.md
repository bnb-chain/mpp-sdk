---
'@bnb-chain/mpp': minor
---

Harden the B402 response and x402 Permit2 boundaries: validate facilitator
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
