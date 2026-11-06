# Replay store

The replay store is the durable, atomic backend that guarantees a given
credential settles **at most once**. It's independent of
`challengeBinding`: the same store backs `mppx-managed`, `mppx-hmac`, and
`stored-lookup`. Spec §9 +
[`draft-evm-charge-00`](https://paymentauth.org/draft-evm-charge-00.html)
both require it.

Implementation: `src/server/Replay.ts`.

## State machine

Each credential maps to a deterministic key (see [Keys](#keys)). A slot
moves through three states:

```
            reserve (atomic CAS — fails if key already present,
   (absent)  UNLESS it is an unprotected stale slot — see below)
        │   ─────────────────────────────▶ inflight
        ▲                                     │
        │     settle succeeds on-chain        │  settle fails BEFORE
        │   ┌───────────────────────────────┐ │  on-chain commit
        │   ▼                                 │ ▼
        │ markConsumed                        release ──▶ (absent)
        │   │                                    (retryable — nonce/tx
        │   ▼                                     not consumed on-chain)
        │ consumed  (terminal — replay rejected)
        │
        └── unprotected `inflight` may be reclaimed after inflightTtlMs
            (SDK payment reservations are protected and require reconciliation)

              settle committed on-chain but a
              post-commit check failed (e.g. Transfer-log
              mismatch, or a store write threw after success)
                          │
                          ▼
                      rejected  (terminal — known-bad, NOT retryable;
                                 the nonce/tx IS consumed on-chain)
```

- **reserve** — atomic compare-and-set. Reserving a key that's already
  `inflight` / `consumed` / `rejected` MUST fail without racing. This is
  what stops two concurrent requests from both settling the same
  credential. Only an unprotected `inflight` slot older than
  `inflightTtlMs` can be reclaimed inside the same CAS. SDK payment
  reservations are protected and never expire automatically.
- **release** — only valid from `inflight`, and only when settlement did
  NOT commit on-chain (broadcast rejected, simulate failed, balance /
  allowance check failed). Returns the slot to absent so a corrected
  retry can proceed.
- **markConsumed** — `inflight` → `consumed` after a confirmed on-chain
  settlement. Terminal.
- **markRejected** — `inflight` → `rejected` when the credential is
  known-bad in a way that consumed the on-chain nonce/tx anyway (so it
  can never replay, but we don't pretend it succeeded). Terminal.

### Protected reservations and explicit reconciliation

Every SDK verifier and B402 settlement path atomically reserves with
`preventReclaim: true` **before** it reads or broadcasts a potentially final
payment. Protected reservations remain blocked regardless of age. A timeout,
HTTP failure, or failed `markConsumed` write cannot prove that payment did not
settle; elapsed time must not make that payment redeemable again. Definitive
pre-settlement failures still release their own fencing token for a clean retry.

An operator must reconcile stranded protected slots against the chain,
facilitator outcome, and application fulfillment before retrying. Confirmed
payments become `consumed`; rejected credentials become `rejected`. Only a
credential proven not broadcast, not settled, and no longer capable of settling
may be released. A process crash before payment can therefore require operator
reconciliation rather than an automatic retry. This is a deliberate availability
tradeoff for payment uniqueness.

The lower-level `reserve` / `reserveB402Slot` primitives retain TTL recovery
for callers explicitly managing pre-payment work without `preventReclaim`.
Only **unprotected** `inflight` slots are reclaimable. TTLs must be positive
safe integers. Terminal state changes remain explicit operations; protected SDK reservations
are never automatically replaced by a successor.

**Upgrade:** drain and reconcile pre-upgrade inflight slots, which do not
contain `preventReclaim`, before serving new traffic. Do not run old and new
settlement workers together during that transition. Store backends must preserve
the flag and must not expire or evict protected, consumed, or rejected keys
using a backend-native TTL. Backup restoration and manual deletion must retain
settlement and fulfillment history.

### Terminal-commit phase (double-spend guard)

Once a verifier confirms the on-chain settlement succeeded, it flips an
internal `terminalPhase` flag. After that point the verifier MUST NOT
`release` the slot even if a _subsequent_ step throws (e.g. the
`Transfer`-log assertion fails, or the `markConsumed` store write itself
errors). Releasing post-commit would let the same already-settled
credential be replayed for a second on-chain settlement. In the
terminal phase a failure routes to `markRejected` (best-effort) and the
slot stays non-absent — never back to absent.

### Store-error normalization

Store backends throw heterogeneously (Redis `ECONNRESET`, Postgres pool
timeout, etc.). `getReplaySlot` / the reserve-and-settle path normalize
these into `ReplayStoreUnavailableError` so the verifier can decide
deterministically. The terminal-phase gate above takes precedence: a
store error AFTER on-chain commit never releases the slot.

### Store outages

Final consumption writes retry transient failures three times and then emit an
operator warning while returning the paid receipt. The previously persisted
protected reservation continues blocking replay after those retries fail and
after the old inflight TTL passes. Operators should resolve the stranded state;
the SDK does not infer non-payment from storage unavailability.

## Keys

Every key goes through a factory helper in `Replay.ts` — the key shape
includes the dimensions that make a settlement unique (chain, contract,
signer, nonce / tx hash) so the same nonce on two different Permit2
deployments (or two chains) doesn't collide:

| Factory      | Credential type(s)       | Key format                                                               |
| ------------ | ------------------------ | ------------------------------------------------------------------------ |
| `permit2Key` | `permit2`                | `bnb-mpp:evm:charge:permit2:{chainId}:{permit2Address}:{signer}:{nonce}` |
| `authKey`    | `authorization`          | `bnb-mpp:evm:charge:auth:{chainId}:{token}:{from}:{nonce}`               |
| `txHashKey`  | `transaction` AND `hash` | `bnb-mpp:evm:charge:txhash:{chainId}:{txHash}`                           |

Notes on the factories:

- **One merged keyspace for `transaction` + `hash`.** Spec §8 defines
  the SAME replay token for both credential types: the transaction
  hash. `txHashKey` deliberately omits the credential type from the
  key — a transfer settled via a `transaction` credential must not be
  redeemable again as a `hash` credential for a second equal-priced
  challenge (or vice versa). Keying by credential type would split that
  single token into two independent slots and let one on-chain transfer
  settle two charges.
- **Permit2 nonces are BigInt-canonicalized.** The EIP-712 message
  hashes `BigInt(nonce)`, so `"1"` and `"01"` carry the identical
  signature. `permit2Key` keys on `BigInt(nonce).toString()` — keying
  on the raw wire string would give re-encodings of the same nonce
  distinct slots, and concurrent submissions of both would each pass
  `reserve()` and double-broadcast the settlement.
- **Signer addresses come from signature recovery** (`verifyTypedData`),
  never from the credential payload's stated identity, and all address
  inputs are lowercased so EIP-55 casing can't split a keyspace.

## Production requirements

Spec §9 requires the store to be:

1. **Durable across processes / pods.** A single Node-process `Map` makes
   replay protection per-pod on a multi-pod deployment — N pods could each
   settle the same credential once. Not acceptable in production.
2. **Atomic.** `reserve` under an already-`consumed` key MUST fail
   without racing.

What the SDK enforces vs. what it can't:

| `NODE_ENV`            | `params.store` omitted                                 |
| --------------------- | ------------------------------------------------------ |
| `production`          | `preflightCharge` **throws** at startup                |
| `development` / unset | defaults to `Store.memory()` + one-time `console.warn` |
| `test`                | silent default to `Store.memory()` (no log noise)      |

When a store IS provided under `production`, it's accepted on presence
alone — the SDK can't structurally tell a Redis client from a `Map`
wrapper across the FFI boundary. Durability is therefore a
deployment-side claim: pass a real durable store and own the §9 promise.

### Executable conformance check

Run the public conformance kit against the same backend configuration used by
the deployment:

```ts
import { replayStoreConformance } from '@bnb-chain/mpp/testing'

test('production replay store', async () => {
  await replayStoreConformance(() => createRedisReplayStore({ namespace: 'mpp-conformance' }), {
    // Optional: a second client connected to the SAME namespace verifies
    // cross-connection atomicity instead of one object only.
    createPeerStore: () => createRedisReplayStore({ namespace: 'mpp-conformance' }),
  })
})
```

The kit checks exclusive reservation, fencing tokens, stale-inflight reclaim,
terminal-state immutability, and concurrent claims. Run it against an isolated
test namespace: terminal test slots intentionally cannot be deleted through the
replay Interface.

Passing does **not** prove persistence across restarts, geographic durability,
encryption, or the absence of an external TTL. Those remain operational
deployment properties.

## Suggested durable backends

- **Redis** — implement the complete update callback with a Lua script or
  equivalent transaction, including fencing and terminal-state guards.
- **Postgres** — implement update in a transaction with row locking or an
  equivalent serializable CAS.
- **Cloudflare Durable Objects** — the single-writer model can implement the
  required update semantics. Plain eventually-consistent KV is not sufficient
  for the replay CAS.

⚠️ **Do not attach a backend TTL (Redis `PX` / `EXPIRE`, KV
`expirationTtl`) to replay slots.** Terminal slots (`consumed` /
`rejected`) must never expire — an expired `consumed` slot re-admits an
already-settled credential for a second settlement. Protected `inflight`
slots must remain present until explicit reconciliation. Only unprotected
pre-payment reservations can be reclaimed by the library's timestamp check
after `inflightTtlMs` (see [protected reservations](#protected-reservations-and-explicit-reconciliation)).

The store implements `ChargeStore` (an `mppx` `Store.AtomicStore`-shaped
interface). `Store.memory()` from mppx is acceptable **only** for tests
and local single-process dev.

## Deployment hardening: rate-limit the verify endpoint (audit L01)

Credential verification is deliberately **free to attempt** for two of the
four credential types, which makes your RPC provider the resource an
attacker spends:

| Credential      | Cost to forge an attempt                               | RPC calls per garbage attempt                                                                          |
| --------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `hash`          | none — any random 32-byte hex                          | up to 2 (`getTransactionReceipt` + `getBlockNumber`), then the slot **releases** for unlimited retries |
| `transaction`   | a validly-signed but unfunded tx (local key, no funds) | up to 4 (broadcast attempt + receipt + mempool lookup + nonce probe)                                   |
| `authorization` | real EIP-712 signature required                        | probes gated behind `balanceOf` / `authorizationState`                                                 |
| `permit2`       | real EIP-712 signature required                        | probes gated behind `allowance` / nonce checks                                                         |

The SDK intentionally does **not** `markRejected` a not-found `hash` — that
would let an attacker permanently poison a future legitimate tx hash — so a
zero-cost garbage submission can repeat forever. DoS/cost protection is the
**deployment's rate limiter**, not the SDK:

- Rate-limit the paid endpoint per client IP / API key **before** the
  verify hook runs (any standard reverse-proxy or middleware limiter).
- Alert on sustained `hash` / `transaction` verification failures — a
  spike is either an integration bug or someone running up your RPC bill.
- If you self-host the RPC node, budget for the 2–4 calls per attempt
  above; if you use a metered provider, a limiter directly caps your bill.
- Also cap request body size at the front door (the SDK's wire schema caps
  numeric/hex field lengths — audit M04 — but the outermost body limit is
  the deployment's).

## Deployment hardening: sweep the stored-lookup challenge store (audit I02)

Only relevant to `challengeBinding: { mode: 'stored-lookup' }`. Every 402
issued calls `rememberChallenge`, and anyone can trigger 402s for free —
without cleanup, the challenge store grows unboundedly. The SDK provides
`forgetChallenge` but no automatic sweep (the `ChargeStore`/`ChallengeStore`
interface has no scan primitive to build one on).

Treat it like a session store:

- Call `forgetChallenge(store, id)` after the matching replay slot is
  marked `consumed` (the challenge can never be redeemed again).
- Give challenge entries a backend TTL slightly beyond the challenge
  `expires` window (e.g. `expires + 1h`). Unlike **replay** slots — which
  must NEVER expire (see the warning above) — challenge snapshots are safe
  to expire: an expired challenge is already rejected by `Expires.assert`
  before the lookup runs, so a missing entry changes nothing.
- On Redis: `SET key value PX <ttl>` in your `ChallengeStore` adapter;
  on Postgres: a periodic `DELETE ... WHERE expires_at < now()`.
