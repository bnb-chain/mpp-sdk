---
'@bnb-chain/mpp': minor
---

PR5 — EIP-3009 authorization credential verifier (`verifyAuthorization`,
spec §8.2) live: 16-step algorithm. Local validation (steps 1-8):
`payload.to` / `payload.value` / `payload.nonce` (derived via
`eip3009Nonce`) match the challenge, `validBefore > now`,
`validAfter <= now`, curated EIP-712 domain (tokenName + tokenVersion)
is supplied via ctx (preflightCharge resolves via
`getCuratedEip712Domain` only when `'authorization'` is in the
resolved credential set), `recoverTypedDataAddress` recovers the signer,
and `recoveredSigner === payload.from` (with optional
`credential.source` lockstep). On-chain (steps 9-16): atomic reserve on
`authKey(chainId, currency, recoveredSigner, payload.nonce)`,
`balanceOf(from) >= value`, `parseSignature` splits into (v,r,s),
simulate + write `transferWithAuthorization` via settlementSigner,
`waitForTransactionReceipt`, strict Transfer-log match. Replay
semantics: pre-success failures release the slot (nonce unconsumed),
post-success log mismatch is `markRejected` (token consumed nonce on-chain).

All four credential paths (hash, transaction, permit2, authorization)
are now live; the PR1 `notImplemented` stub is removed from
`src/server/Charge.ts`.
