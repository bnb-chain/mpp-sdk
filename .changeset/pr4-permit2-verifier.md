---
'@bnb-chain/mpp': minor
---

PR4 — Permit2 credential verifier (`verifyPermit2`, spec §8.1) live:
19-step algorithm supporting both single-permit (no splits) and batch-
permit (splits per draft §4.2.3) paths. Local validation (steps 2-11):
deadline > now, length / token / amount / recipient / splits matching,
`witness.challengeHash` matches `computeChallengeHash(challenge.id,
challenge.realm)`, EIP-712 typed-data recovery via
`recoverTypedDataAddress`, and `credential.source` REQUIRED + must equal
`did:pkh:eip155:<chainId>:<recoveredSigner>` per draft §6.1. On-chain
(steps 12-19): atomic reserve on `permit2Key(chainId, permit2Address,
recoveredSigner, nonce)`, ERC-20 `balanceOf` + `allowance` checks,
`simulateContract` pre-broadcast, `writeContract` via settlementSigner,
`waitForTransactionReceipt`, strict ordered Transfer-log match against
all `transferDetails[i].(to, requestedAmount)`. Replay semantics:
pre-broadcast failures (balance / allowance / simulate / broadcast)
release the slot (nonce unconsumed); post-success log mismatch is
`markRejected` (nonce consumed on-chain — credential is unreplayable).
