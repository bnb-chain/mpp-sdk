---
'@bnb-chain/mpp': minor
---

Publish B402 as an MPP-native provider extension. Add the shared `b402/charge`
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
