---
'@bnb-chain/mpp': patch
'@bnb-chain/b402': patch
'@bnb-chain/mpp-b402': patch
---

Persist protected payment reservations before verification or settlement. Ambiguous outcomes and failed final storage writes now require explicit reconciliation rather than age-only retry. Drain/reconcile legacy inflight entries before upgrading and never expire protected keys in the backend.
