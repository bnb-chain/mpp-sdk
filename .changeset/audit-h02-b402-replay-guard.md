---
'@bnb-chain/mpp-b402': minor
'@bnb-chain/b402': minor
---

Security (audit H02): add replay/idempotency protection to every B402 settlement path. A resubmitted credential — client retry, duplicate request, or deliberate replay — can no longer settle more than once.

- `@bnb-chain/b402/server` gains a three-state replay guard (`reserveB402Slot` / `markB402Consumed` / `markB402Rejected` / `releaseB402Slot`, plus `b402ReplayKey`) keyed on `(transferMethod, network, asset, payer, nonce)`, with fencing tokens, stale-inflight TTL reclaim, and write-once terminal states. The store contract is structural — mppx `Store.memory()` / `Store.redis(...)` satisfy it directly.
- BREAKING: `@bnb-chain/mpp-b402`'s `charge()` now REQUIRES a `store` parameter. The verify hook reserves the slot before the facilitator's verify/settle run; an ambiguous settlement (`B402SettlementUnknownError`) keeps the slot blocking retries until the `inflightTtlMs` reconciliation window (default 10 min) elapses.
- `B402FacilitatorClient` and `createB402Facilitator` accept an optional `store` guarding `settle()`, and warn at construction when omitted.

Production deployments MUST pass a durable atomic store shared by all instances; `Store.memory()` guards a single process only.
