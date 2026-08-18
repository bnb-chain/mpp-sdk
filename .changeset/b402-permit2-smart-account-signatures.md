---
'@bnb-chain/b402': patch
---

Accept smart-account (ERC-1271/ERC-7739) signatures on the permit2-exact
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
