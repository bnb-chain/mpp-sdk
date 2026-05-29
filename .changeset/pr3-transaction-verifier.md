---
'@bnb-chain/mpp': minor
---

PR3 — Transaction credential verifier (`verifyTransaction`, spec §8.3)
live: 16-step algorithm. Local validation (steps 1-8) parses the raw
EIP-1559 transaction, asserts type / chainId / `to` / `value=0` / data
selector / decoded transfer args strictly match the request, and
recovers the sender. Replay slot is only reserved AFTER local checks
pass (step 10). Broadcast (step 11) categorizes node errors: definitely-
rejected (invalid signature / fee / chainId mismatch / malformed RLP)
release the slot, while possibly-accepted errors (already-known / nonce-
too-low / underpriced replacement) check `getTransactionReceipt` + a
mempool probe before releasing. Receipt assertions (steps 13-14) handle
revert + Transfer-log mismatch with `markRejected`. Default
`confirmations` comes from `curatedDefaultConfirmations(chain)`.
