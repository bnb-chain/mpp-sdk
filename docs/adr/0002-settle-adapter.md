# ADR 0002 — `SettleAdapter` (pluggable EIP-3009 settlement)

- **Status:** Accepted
- **Scope:** `authorization` (EIP-3009) credential settle step only

> B402-specific Adapter decisions in this historical ADR are superseded by
> [ADR-0005](0005-b402-provider-extension.md). The generic `SettleAdapter`
> Seam remains supported.

## Context

The EVM Charge flow's `authorization` verifier (`src/server/Authorization.ts`)
both **verifies** the EIP-3009 signature and **settles** it on-chain by
broadcasting `transferWithAuthorization` from a local settlement signer. That
couples "who plays the facilitator" to "this deployment runs a hot signer".

A second, independent rail now exists: the Binance OnchainPay **b402**
facilitator (an **x402 v2** facilitator — see [b402.md](../b402.md)) verifies +
settles as a hosted service. Both produce the same outcome (a `402` → a signed
EIP-3009 payment → on-chain settlement → receipt); they differ only in **where
the broadcast happens** — your own signer vs. a hosted facilitator. We want to
swap that without forcing buyers onto a different protocol.

The key realisation: the **buyer-facing wire and the settlement backend are
orthogonal**. x402's own model says buyers never talk to the facilitator — the
merchant mediates. So the buyer can keep speaking **mppx** (this SDK's
`draft-evm-charge-00` wire, with full challenge binding and §7.6 receipts) while
the merchant settles via either a local signer or b402. We do **not** abandon
the mppx design to gain b402.

## Decision

Extract the on-chain settle step behind a `SettleAdapter` **seam in core**
(`src/server/Settle.ts`); set it via `ServerParameters.settleBackend`. Core
defines only the seam + the self-host adapter; specific facilitators live
outside core:

- **`LocalSignerAdapter`** (core, default, wired from `settlementAccount`) — the
  original `simulate → write → waitForReceipt`, relocated verbatim. Existing
  deployments are byte-for-byte unchanged (the field is optional; the default
  reproduces today's behaviour).
- **`B402Adapter`** (`@bnb-chain/mpp/b402/mppx` — NOT core) — translates the
  verified EIP-3009 authorization into an x402 v2 payload and forwards it to
  b402's `/settle`. No local signer needed (b402 broadcasts + pays gas). It is
  the only b402 subpath that depends on the charge core; `@bnb-chain/mpp/b402`
  (wire) and `@bnb-chain/mpp/b402/server` (client) stay core-free.

The verifier keeps **all** challenge binding, the replay 3-state machine,
front-run recovery, `terminalPhase` locking, the §7.6 receipt, **and the
trust-critical check that the settled transfer matched the signed
authorization**. It delegates only the broadcast and reads back a normalized
`SettleReceipt` (`status` / `transactionHash` / `proof`), where `proof` is a
discriminated union:

- `{ kind: 'logs', logs }` — the local signer broadcast the tx itself; the
  verifier matches the authorized ERC-20 `Transfer(currency, from, to, value)`.
- `{ kind: 'facilitator', payer, network, amount? }` — b402 broadcast it and
  ECHOES back what it settled; the verifier asserts `payer === from`,
  `network === eip155:<chainId>`, and `amount === value`, else it `markRejected`s
  the slot and fails. On a **success** the adapter requires `amount` (a `success`
  that omits it is pending, not a receipt — see below), so it is always present
  there; `amount?` is optional in the type only because the **reverted** proof
  (which the verifier never reads — it runs the front-run probe) may omit it.

**Trust model — b402 is a trusted settlement ORACLE, not a relayer core
re-confirms.** Core trusts b402's `success` flag and the tx hash it returns; the
`facilitator` path does NOT fetch the receipt or match on-chain Transfer logs,
and does NOT re-wait `SettleContext.confirmations` (only the local-signer path
does — it broadcasts the tx itself). The echoed `payer`/`network`/`amount`
cross-check is therefore **auxiliary**: it catches b402 settling a DIFFERENT
transfer than authorized — it does NOT catch a facilitator fabricating `success`
for a tx that never landed (that is the accepted trust boundary; use
`LocalSignerAdapter` if you need core to confirm on-chain). We deliberately did
NOT make core re-confirm the b402 tx: that would negate b402's broadcast +
gas-sponsorship value and reduce it to a slower local signer. The integrity
check still lives in **core**, applied uniformly — never delegated to each
adapter (an adapter that merely asserted its own honesty would be no check at
all) — and runs at zero extra round-trip (b402 already returns those fields).

Because that path is the sole post-settle integrity check, a `success` must
POSITIVELY confirm the authorized transfer, with a principled split between
**missing** and **wrong** info:

- **Missing info → pending.** A `success` with no tx hash or no settled `amount`
  is out-of-spec / incomplete; the adapter throws `SettlePendingError` (slot
  stays inflight, reclaimed after `inflightTtlMs`), never a fabricated success
  receipt and never a terminal reject (the settlement state is genuinely unknown).
- **Wrong info → failed.** A complete proof whose `payer`/`network`/`amount`
  contradicts the authorization is `markRejected` + failed. `network` is compared
  by parsed chain id (`caip2ChainId`, tolerant of cosmetic CAIP-2 format diffs
  like `EIP155:1`); an unreadable or different chain rejects. (b402 emits
  canonical `eip155:<n>`, so this never fires for an honest settlement.)

The `proof` union also makes the two settlement modes unable to represent each
other's illegal states (no `verified:true`-with-logs ambiguity).

## Scope limits (v1)

- **eip3009 only.** `B402Adapter` settles the `authorization` path only. The
  `permit2` witness differs between mppx (`PaymentWitness(challengeHash,externalId)`) and
  x402/b402 (`witness.{facilitator,to}`), so an mppx permit2 credential cannot be
  forwarded to b402; permit2 always settles locally (and still requires a
  signer). `transaction` / `hash` are payer-broadcast and need no facilitator.
- **b402 recipient is registered.** When settling through b402, the challenge
  `recipient` MUST be your registered b402 payout, and the token's on-chain
  EIP-712 `name` must match a b402 `/supported` eip3009 kind. b402 rejects other
  recipients (observed as `invalid_exact_evm_payload_recipient_mismatch`).

## Consequences

- One config field switches self-host ↔ delegate; buyers are unaffected
  (same mppx wire, same `Payment-Receipt`). `receipt.reference` is the local
  signer's tx or b402's tx, indistinguishably.
- The adapter interface is the extension point for future settlement backends
  (other x402 facilitators, account-abstraction relayers, …) — declared via
  `SettleAdapter.settles`. The name stays generic, but v1 covers the
  `authorization` (EIP-3009) credential ONLY: a future credential gets an **added**
  method (e.g. `settlePermit2`), not a forced generalization of
  `settleAuthorization`. `settles` is the machine-checkable capability list the
  preflight/verifier wiring routes against.
- The settlement engine is reusable as a self-hosted facilitator
  (`LocalSignerAdapter`); b402 is the hosted alternative.
