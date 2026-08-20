---
'@bnb-chain/b402': patch
'@bnb-chain/mpp-b402': patch
---

Security (audit H02 follow-up): close a slot-squatting window the replay guard itself introduced. The guard keys a replay slot on the payer address, and on paths where that address came from the payload's self-declared `from` it was claimed **before** anything had checked whether the signature was real — so an attacker who copied a victim's publicly-visible address and nonce onto a garbage-signed payload could claim the victim's slot first, and the victim's genuine payment was rejected as "already in progress" without ever reaching the facilitator. Transient and self-healing (the forged request is rejected downstream, which releases the slot), no fund loss, but a real denial-of-service surface.

- `@bnb-chain/mpp-b402`'s `createB402Facilitator` now recovers the EIP-3009 payer **locally** (`recoverEip3009Payer` + compare against the declared `from`) instead of trusting the wire value — matching the `b402/charge` main path. Garbage signatures are refused before any slot is touched, at no extra network cost. This path was exposed for **all** EIP-3009 payments, not only smart-account ones.
- `@bnb-chain/b402`'s `B402FacilitatorClient.settle()` now confirms the signature through the facilitator's idempotent, gas-free `/verify` **before** reserving, on the smart-account (ERC-1271) permit2 path where no local recovery is possible, and cross-checks the facilitator-reported payer against the address the slot would be keyed on. A rejected payment returns a normal `success: false` settle response and claims nothing. The EOA path is unchanged — local recover-and-compare already gates it, with no added round trip.

The slot is still claimed before the irreversible `/settle` on every path, so H02's replay guarantee is unchanged. The `mpp-b402` `charge()` main path was never affected (it already recovered locally on both rails).
