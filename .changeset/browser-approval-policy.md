---
'@bnb-chain/mpp-b402': patch
---

Enforce the trusted Permit2 spender before invoking an allowance reader that may approve tokens. The browser example now requires independent buyer policy and approves only the payment amount after policy checks.
