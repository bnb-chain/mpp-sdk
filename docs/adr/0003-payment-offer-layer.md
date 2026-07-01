# ADR 0003 — Payment Offer Layer (multi-rail negotiation)

- **Status:** Proposed — design COMPLETE; **Phase 1 implemented** (`src/client/pay/` — the
  `pay({ policy })` buyer surface over the mpp credentials, single-wire, covered by
  `src/client/pay.test.ts`). Phases 2-4
  (the standalone x402 offer, the gateway + `PaymentIntentStore`, Permit2-over-b402) remain
  design-only. Extends [0002](0002-settle-adapter.md). The `PaymentIntentStore` was adversarially
  hardened and its six opens resolved (see "`PaymentIntentStore` — resolved decisions").
- **Scope:** A negotiation layer ABOVE the wire that lets one buyer integration and one
  merchant config span multiple payment rails (mpp EVM Charge + x402/b402 + future), without
  changing any wire or the `draft-evm-charge-00` credential set.

## Context

The SDK now speaks two settlement rails: this SDK's mppx EVM Charge wire, and the Binance
OnchainPay (b402) x402 v2 wire. We want **one buyer integration** (the facilitator invisible
to the buyer's code) and a **merchant who just picks adapters per resource** — but two hard
facts constrain how far that can go:

1. **`draft-evm-charge-00` fixes the credential set.** §4.2.2: `credentialTypes` valid values
   are EXACTLY `permit2` / `authorization` / `transaction` / `hash`; §6 requires the server to
   reject any other `payload.type`. Verified in code: `src/Methods.ts:28` is the single source of
   truth and has no fifth value. So we may **not** unify rails by inventing an mpp credential like
   `b402-permit2`, nor fold a b402 payload into the mpp `permit2` credential.

2. **The Permit2 facilitator-binding XOR theorem.** The buyer's Permit2 signature binds BOTH the
   `spender` and the `witness` into the EIP-712 digest (`src/protocol/TypedData.ts:73,76`), and
   on-chain Permit2 enforces `msg.sender == signed spender`. Since "who pays gas" == "who is
   `msg.sender`" == "the signed spender", on Permit2:

   > **facilitator-invisible-signature ⊕ facilitator-gas-sponsorship** — you can have either,
   > never both. (A post-hoc adapter cannot retarget a signed Permit2 to a different facilitator;
   > it holds no buyer key.)

   EIP-3009 escapes this only because `transferWithAuthorization` has no `spender` field — any
   address may submit — which is exactly why today's `B402Adapter` can settle an mpp
   `authorization` credential via b402 after the buyer signed ([ADR 0002](0002-settle-adapter.md)).
   Permit2 cannot be ported to that model.

The conclusion that shapes this ADR: **unify the UX, not the protocol.** The buyer's _integration
code_ and the merchant's _config_ can be one each; the _signed cryptographic artifact_ and the
_wire_ stay rail-specific. Negotiation must therefore live a layer ABOVE the wire — like HTTP
content negotiation — never inside the credential set.

## Decision

Introduce a **Payment Offer Layer**: a set of SDK types + adapters (no new wire) that maps a
merchant config → multiple standard offers in one `402`, and a buyer policy → a route selection
across them.

### Buyer surface — `pay(url, { wallet, policy })`

The buyer expresses a **payment intent**, never a rail:

```ts
await pay('/api/premium/report', {
  wallet,
  policy: {
    mode: 'prefer-gasless', // ranking preset
    maxAmount: '1.00', // hard filter
    allowedAssets: [{ chainId: 97, address: '0x180b…6a49' }], // hard filter — (chainId, address), the wire identity (NOT symbol)
    allowedChains: [97], // hard filter — numeric chainId
    allowApproval: true, // hard filter (one-time Permit2 approve)
    allowPayerGas: false, // hard filter
    // allowFacilitator: true,  // hard filter (trust) — Phase 2+ only; NOT in the Phase-1 policy (no facilitator route exists yet)
  },
})
```

The resolution rule that makes `policy` unambiguous:

> **Hard constraints FILTER. `mode` RANKS.**

```
merchant-offered rails (per adapter × token × credentialType)
  │  FILTER  ← hard constraints (the booleans) + wallet capability + the Permit2 XOR rule
  ▼  viable set
  │  RANK    ← mode preset
  ▼  pick first  →  empty? → "no acceptable method" (fail-closed)
```

`mode` is a named ranking preset (a bundle of ranking + default hard constraints that explicit
booleans override):

| mode              | ranking                                        | implied hard constraint |
| ----------------- | ---------------------------------------------- | ----------------------- |
| `auto` (default)  | merchant's declared `primary`/`fallback` order | —                       |
| `prefer-gasless`  | buyer-gasless first                            | —                       |
| `require-gasless` | buyer-gasless first                            | `allowPayerGas: false`  |
| `prefer-direct`   | non-facilitator first                          | —                       |
| `manual`          | the `routePreference` order                    | —                       |

`routePreference` (explicit rail-tag list) is an **advanced escape hatch**, only consulted under
`mode: 'manual'`. Normal buyers never see `b402` / `permit2` / `facilitator`.

### The `402` carries TWO standard wires — not a proprietary envelope

The 402 response contains both standard offers in DISJOINT parts; neither is invented here:

```
402 Payment Required
  ├─ WWW-Authenticate: Payment id="…", method="evm", intent="charge", request="<b64>"
  │     standard mpp EVM Charge challenge — credentialTypes ⊆ {permit2,authorization,transaction,hash}
  └─ body: { x402Version, accepts: [ PaymentRequirements … ] }
        standard x402/b402 offer — present only when a b402 adapter is configured
```

A pure-mpp client reads only the header; a pure-x402 wallet reads only `res.json().accepts[]`.
Retry dispatch is collision-free: `Authorization: Payment …` → mpp verifier; `X-PAYMENT` → b402
verify+settle. Receipts differ accordingly (`Payment-Receipt` vs `X-PAYMENT-RESPONSE`).

The unified `paths[]` shape (with `gasless` / `requiresApproval` / `trust`) is the **client SDK's
derived logical view** after parsing those two standard wires — it is NEVER the wire bytes.

```
wire (2 standard pieces)  ──SDK parse+normalize──▶  logical view: paths[]  ──selectRoute──▶  1 route
```

### Merchant surface — `createPaymentGateway({ adapters, resources })`

The merchant declares **price + supported paths + adapters**, not wire differences. Adapters carry
their own `token(s)` and `recipient`/`payout` (they legitimately diverge — see Blocker 2):

```ts
const gateway = await createPaymentGateway({
  adapters: {
    mpp: mppAdapter({ settlementAccount, challengeBinding: { mode: 'mppx-managed' } }),
    binance: x402ProviderAdapter({ client: b402Client, payout, tokens: ['U'] }),
    aa: paymasterAdapter({ client: aaClient }),
  },
  resources: {
    '/api/report': {
      price: { chain: 'bsc-testnet', token: 'U', amount: '1.00' },
      paths: [
        { adapter: 'binance', method: 'eip3009', role: 'primary' },
        { adapter: 'mpp', method: 'authorization', role: 'fallback' },
        { adapter: 'mpp', method: 'permit2', role: 'fallback' },
        { adapter: 'aa', method: 'sponsored-transfer', role: 'experimental' },
        // 'hash' is compatibility-only and opt-in — see the IntentStore `hash` caveat.
      ],
    },
  },
})

// route handler — provider-agnostic
const payment = await gateway.requirePayment(req, { resource: '/api/report' })
if (payment.status === 'required') return payment.respond402(res)
return payment.withReceipt(res.json({ … }))
```

(A simplified `primary` / `fallback: […] / disabled: […]` rail-tag form is sugar over `paths`.)

`gasless` / `requiresApproval` / `trust` are **derived by the SDK** from `(adapter, method, token,
wallet state)` — the merchant does NOT assert them (assertion drifts; e.g. Permit2 is "gasless
payment + maybe a one-time `approve` that costs gas", so effective gasless-ness is wallet-state
dependent and only `selectRoute` can decide it).

### Three seams — `WireCodec` / `ProviderAdapter` / `IntentStore`

The gateway is built from three stable seams so adding the Nth provider never grows a
`hasMpp / hasX402 / hasFoo` dispatch:

- **`WireCodec` (one per HTTP payment wire, NOT per provider)** — owns "how to read/write a wire".
  `detect(req)` recognizes its header and returns the raw credential + a `credentialHash`;
  `getOfferKey(credential)` derives the key mapping a received credential back to a stored offer
  (mpp: the bound `challenge.id`; x402: `hashCanonical(decodeXPayment(raw).accepted)`);
  `serializeOffers(offers)` emits its part of the 402; `parseOfferResponse(res)` (client side) yields
  `LogicalPath[]`. Two x402 providers (b402, Coinbase, …) share ONE `x402WireCodec` — adapters never
  scan headers themselves.
- **`ProviderAdapter` (one per service)** — `describeOffers(ctx)` + `handlePayment(ctx)` (verify +
  settle against a specific provider: b402 / self-host signer / AA paymaster / …). Decoupled from the
  wire: an x402-wire provider is `x402ProviderAdapter({ client })`. (Today's `B402Adapter` is
  settle-only — `settles = ['authorization']`; the offer-emitting half is net-new — Blocker 3.)
- **`PaymentIntentStore`** — the cross-rail "succeed at most once" guarantee (next subsection).

"Offer normalization" is just the codecs' two directions (server `serializeOffers` → wire; client
`parseOfferResponse` → `LogicalPath[]`) aggregated client-side into one `paths[]` — not a separate
fourth component.

Dispatch is wire-agnostic and enforces "one credential per retry" by construction:

```
const matches = wireCodecs.map((c) => c.detect(req)).filter(Boolean)
if (matches.length === 0) return issue402(req)
if (matches.length > 1)  return failClosed('ambiguous_payment_credentials')  // two headers → NO settle
const cred  = matches[0]
const offer = intentStore.resolveOffer(cred.codec.getOfferKey(cred))         // → { intentId, adapterId, offerId }
// reserve → adapters[offer.adapterId].handlePayment → settle / release  (see IntentStore)
```

`StoredOffer` (server) binds provider × wire × price + DERIVED `traits` (`gasPayer` /
`requiresApproval` / `trust` / `finality`); `LogicalPath` is its client-visible projection. `traits`
are never merchant-asserted. `finality` connects to [0002](0002-settle-adapter.md):
`provider-attested` = a trusted facilitator (b402 — no on-chain re-fetch) vs `onchain-confirmed` =
the local signer waits for the receipt — exposable as a buyer policy.

**Adding a provider:** reuse an existing wire → add only a `ProviderAdapter`; a genuinely new wire
(a `Foo-Payment` header) → add a `WireCodec` + a `ProviderAdapter`. Buyer `pay()`, the merchant
resource config, gateway dispatch, and `Methods.ts` all stay unchanged.

### Rail taxonomy — `{wire}:{method}`, and what exists today

A rail tag names the WIRE the buyer speaks plus the credential/method — NOT the settlement backend.
"Settled by b402" is an orthogonal backend choice for an mpp rail:

- `mpp:authorization` — buyer speaks the mpp wire (`Authorization: Payment`), signs EIP-3009; settled
  by the local signer OR a b402 settle backend. **Exists today** — this is what `B402Adapter` does
  (`mpp:authorization` + `settlementBackend: b402`), NOT a standalone b402 route.
- `b402:eip3009` — buyer speaks the x402 wire (`X-PAYMENT`) directly; settled by b402. **To build.**

So `mpp:authorization (backend=b402)` and `b402:eip3009` both EIP-3009-settle via b402 but differ in
which wire the buyer speaks. The standalone `b402:*` x402 offer is needed for x402-native wallets and
is the ONLY path for Permit2-only tokens (USDT/USDC); for EIP-3009 tokens, `mpp:authorization
(backend=b402)` already delivers b402 gas sponsorship on the mpp wire.

### Cross-rail idempotency — `PaymentIntentStore` (the load-bearing piece)

> An adversarial pass (5 lenses) found SIX double-spend holes in the first draft and refuted its
> "intentId is the mutex, payer auxiliary" claim. This is the corrected spec; it is more precise but
> NOT yet at Accepted — see "remaining opens" at the end.

**The mutex is COMPOSITE and credential-class-dependent — `intentId` alone is not enough.** Only
mppx credentials are intent-bound; x402 and hash/transaction are not, so the intent lock must be
paired with the per-rail replay slot that actually binds the money:

| credential class                 | intent-bound?                                       | mutex                                                                                                     |
| -------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| mppx (`authorization`/`permit2`) | yes — nonce = `keccak(challenge.id‖realm)`          | `intentId` primary; `payer` auxiliary                                                                     |
| x402/b402 `authorization`        | NO — random nonce, `accepted` is UNSIGNED plaintext | `intentId` **+ load-bearing** `authKey(chainId, token, recoveredSigner, eip3009Nonce)` cross-intent guard |
| `hash` / `transaction`           | NO — bare `{type,hash}`                             | `txHashKey(chainId, txHash)` primary (one transfer → one intent); `intentId` auxiliary                    |

So `reserve` keys on `(intentId, offerId, credentialHash, payer)` AND, in the SAME logical
transition, CAS-es the underlying per-rail slot (`authKey` / `txHashKey`, the existing
[Replay.ts](../../src/server/Replay.ts) keys). The existing replay keys carry NO `intentId`, so the
intent mutex does not compose for free — it is a second resource that must be reserved atomically
alongside the rail slot (or as a strictly-ordered pair with defined crash recovery — see opens).

```
interface PaymentIntentStore {
  issue(intent): Promise<void>
  // ONE linearizable conditional store mutation — never has()+set(); the branch-read and the
  // write share one linearization point; the intent is ONE key (no per-offer keys).
  reserve({ intentId, offerId, credentialHash, payer, now }): Promise<
    | { status: 'reserved' }
    | { status: 'already-settled'; receipt }      // first-writer-wins; returns the STORED receipt
    | { status: 'duplicate-inflight' }            // same credentialHash (or reclaim-in-progress)
    | { status: 'conflict'; reason }              // different cred/route while inflight → NO settle
    | { status: 'reclaim-lease'; leaseId }        // this caller won a stale-reclaim lease (probe next)
  >
  settle({ intentId, offerId, credentialHash, receipt }): Promise<void>   // write-once; see escalation
  release({ intentId, offerId, credentialHash, reason: 'pre-broadcast-failure' }): Promise<void>
}
```

State per intent: `open → inflight(offerId, credHash, payer, reservedAt) → broadcasting(txRef) →
settled(receipt) [TERMINAL]`. Transitions back to `open` happen ONLY via `release` (pre-broadcast)
or a `reclaiming` lease that resolves to `open` (below). `settle`/`release` MUST re-assert ownership
INSIDE the CAS: `state==inflight && credentialHash==caller && offerId==caller`, else no-op.

**Reclaim is lease-first (the recovery probe is a slow RPC and CANNOT live inside the CAS):**

1. CAS#1 (sync): `inflight && stale` → `reclaiming(owner, leaseExpiresAt=now+reclaimLeaseMs)`;
   already-reclaiming & !expired → `duplicate-inflight`. `broadcasting(txRef)` is **NEVER reclaimable
   regardless of TTL** (its tx may still mine — this closes the "confirmed-not is a lie that becomes
   true moments later" double-spend).
2. PROBE (outside any CAS, read-only, idempotent) — keyed on the SIGNED on-chain nonce / settling
   txHash (shared across intents), never on `intentId`. Class A (on-chain: local signer / hash /
   transaction / b402) = re-run the verify steps against the txHash (receipt → confirmations →
   status → Transfer-triple match), NOT "receipt exists → settled". Class B (provider-attested) has
   NO status re-query (b402 exposes only `/supported·/verify·/settle`) — its probe IS the same
   on-chain `authorizationState`/`AuthorizationUsed` check, valid only because b402 burns a real
   on-chain EIP-3009 nonce. `pending`/non-final/probe-errored → **still-unknown → keep inflight**;
   `confirmed-not` ONLY against final/canonical state.
3. CAS#2 (sync): require `state==reclaiming && owner==me && now<leaseExpiresAt` → `settled` /
   `inflight(me)` / re-`inflight(orig)`; owner/lease mismatch → abandon without writing.

`reclaimLeaseMs` MUST exceed the probe's worst-case latency (the probe is idempotent, so a large
lease is safe). `inflightTtlMs` MUST exceed `max(settlementTimeoutMs, adapter.maxSettleLatencyMs) +
margin` — note `B402Adapter` ignores `ctx`, so a facilitator rail's TTL is the FACILITATOR's confirm
SLA, not core's `settlementTimeoutMs`. An expired-but-inflight record is IMMUNE to `intentTtl`
eviction until terminal; physical store-TTL ≫ `intentTtl + inflightTtlMs`; a sweeper GCs only
terminal records.

**`settle` escalation:** write-once (settling an already-settled intent returns the stored receipt).
If `settle` is called with an **on-chain-final** receipt but a DIFFERENT cred holds the reservation
(or it settled under a different cred), surface `DOUBLE_SETTLE_DETECTED` (alarm + reconciliation
hook) — NOT a benign no-op (that hides a real second on-chain charge).

**`Payment-Intent` header MUST (lookup hint, never authority):**

- The `intentId` used by `reserve` is the GATEWAY-derived canonical id, recomputed from SIGNED data:
  mpp = recovered from the bound challenge; x402 = re-derived from the signed economic tuple
  (`recoveredSigner→payer`, `to→payout`, `value→amount`, `domain(chainId,verifyingContract)→
network/asset`) matched against the `StoredOffer`. The `Payment-Intent` header only LOADS the
  candidate record; before reserve, `loaded.intentId == signature-derived` else reject
  `intent-binding-mismatch`. `offerKey` from the unsigned `accepted` may only NARROW, never
  authenticate.

**`hash` caveat.** The buyer self-broadcasts BEFORE retrying, so the txHash mutex (not the intent) is
the real guard. Keep `txHashKey` MANDATORY for `hash`/`transaction` (one transfer → one settlement,
cross-intent); a `txHash` already consumed under ANY intent → `already-settled`/`conflict`. `hash`
stays out of primary/fallback (compatibility-only), but its `txHashKey` dedup is NOT optional.

**Capability-leak fix:** `already-settled` returning content on the `intentId` alone is an oracle —
the `intentId` rides as a cleartext header logged by proxies/CDNs. Bind receipt redemption to the
`payer` (a fresh signature from the recovered signer == `intent.payer`) or a separate bearer token
issued at first settle; secrecy of the `intentId` is not authorization.

### `PaymentIntentStore` — resolved decisions (closes the six opens)

The six opens the adversarial pass left are resolved as follows; collectively they make the spec
ready for Accept.

1. **x402 intent-binding is ASSOCIATIVE, not cryptographic — permanent, not a stopgap.** Stock
   EIP-3009 cannot bind an intent (its signed scope is fixed: `{from,to,value,validAfter,validBefore,
nonce}`). DECISION: do NOT pursue an x402 wire extension. The `Payment-Intent` header + signed-
   tuple-recompute give intent ASSOCIATION; the anti-double-spend guarantee is the **per-rail
   `authKey(chainId, token, recoveredSigner, eip3009Nonce)`** — one signed authorization settles at
   most once globally regardless of how many intents reference it. `(payer, nonce)` is the permanent
   guard.
2. **Per-intent scoping; NOT issuance-dedup.** A 402 is issued at GET time, BEFORE any credential, so
   the `payer` is unknown then — issuance cannot be keyed on `(resource, payer)`. DECISION: every 402
   fetch mints a fresh `intentId`; "at most once per purchase" is enforced downstream by the per-rail
   `authKey`/`txHashKey` guards, never by deduping 402 issuance.
3. **Off-chain-only facilitators are not auto-reclaimable.** A provider whose settlement leaves no
   on-chain artifact keyed by the replay token has nothing for the recovery probe to read. DECISION:
   such a provider MUST declare `recoverable: false`; the gateway refuses to register it on a rail
   that promises auto-reclaim, and its stuck intents require an explicit operator
   `markSettledByOperator` / `markReleasedByOperator`. (b402 IS recoverable — it burns a real on-chain
   EIP-3009 nonce — so this only gates hypothetical future off-chain providers.)
4. **The per-rail slot is AUTHORITATIVE; the intent record COORDINATES.** When the intent mutex and
   the per-rail slot are not one atomic write: reserve the per-rail slot FIRST, then the intent
   record; on success mark the per-rail slot consumed FIRST (on-chain truth), then the intent
   `settled`. A reconciliation sweep RE-DERIVES intent state from the authoritative per-rail slot
   (rail consumed → intent settled; rail reserved-but-stale → run the recovery probe). Crash between
   the two writes is self-healing because the rail slot, not the intent record, is the source of
   truth for whether money moved.
5. **Receipt redemption = bearer token (payer-bound), not intentId.** First settle issues a
   short-lived bearer token bound to `(intentId, payer)`; subsequent `already-settled` redemptions
   require that token OR a fresh signature from `recoveredSigner == intent.payer`. The `intentId`
   alone NEVER authorizes content.
6. **Persist the broadcast `txRef`; the windowed scan is a fallback.** The `broadcasting(txRef)`
   sub-state records the tx hash BEFORE the provider call, so recovery is a direct
   `getTransactionReceipt(txRef)` — O(1), no `FRONT_RUN_SEARCH_WINDOW_BLOCKS` tuning. The windowed
   `getLogs` scan remains ONLY for the rare crash-before-persist case.

## Hard boundary (spec compliance — must hold by construction)

- `methodDetails.credentialTypes` stays a subset of `{permit2, authorization, transaction, hash}`.
- mpp `permit2` witness stays `PaymentWitness(challengeHash)`; b402 permit2 rides the x402
  `accepts[]`, never faked as an mpp `permit2`.
- The rail-tag namespace (`'b402:eip3009'`, `'mpp:permit2'`, …) is **strictly SDK-internal** — a
  code-review assertion must guarantee no path from a rail tag into `Methods.ts`'s credential enum
  (it throws on a non-spec literal — fail-loud, but forbid it by construction anyway).
- The x402 offer is a **sibling** body/field that does NOT mutate the bytes the mpp challenge binds
  over (mppx-hmac / stored binding byte-compares the serialized request).
- No offer-layer field inside the mpp credential payload or the x402 payment payload **semantics**.
  A documented correlation token (the `paymentIntentId`, carried as the HTTP-level `Payment-Intent`
  header) IS allowed — opaque, ignorable by a standard single-rail client, and it never alters what
  either wire settles. (i.e. "no private bytes" applies to the credential / payment payloads, not to
  a documented HTTP-level correlation header.)
- `WireCodec.getOfferKey` canonicalization must be **byte-stable and pinned** (same hazard class as
  the mpp challenge binding): the `accepted` a buyer echoes must `hashCanonical` back to the exact
  stored offer, or the gateway cannot resolve which offer/adapter a credential fulfills. Lock the
  canonical form and test buyer-signer ↔ server byte-for-byte.

## Open decisions / blockers (resolve before implementation)

1. **RESOLVED — `PaymentIntentStore`.** State machine under "Cross-rail idempotency"; the six prior
   opens are closed under "`PaymentIntentStore` — resolved decisions". Remaining work is
   IMPLEMENTATION (the store + the gateway), not design: build the linearizable CAS store (memory +
   Redis/DB), the lease-based reclaim, and the reconciliation sweep — covered by the Phasing section.
2. **BLOCKER — token/recipient per-adapter, not per-resource.** A single `{token, recipient}`
   cannot express divergent offers (b402 eip3009-only `$U` to a b402 payout vs mpp permit2
   USDT/USDC to a different signer). `price.token` is the default; allow per-path/per-adapter
   override and put `recipient`/`payout` on the adapter.
3. **BLOCKER — build the x402 `ProviderAdapter` offer half.** Today `B402Adapter` only settles the
   mpp `authorization` credential (`settles = ['authorization']`); `describeOffers()` + the x402
   `handlePayment()` (verify+settle on the `X-PAYMENT` wire) are net-new. b402 permit2 additionally
   needs a Permit2 `PaymentPayload` variant in `@bnb-chain/mpp/b402` (it models only the EIP-3009
   `ExactEvmPayload` today) + a buyer-side Permit2 signer for b402's `witness.{facilitator,to}`.
4. **Two distinct fail-closed checks (do NOT conflate).**
   - **Deploy-time, at `createPaymentGateway()`** — validate the MERCHANT config only: every adapter
     exists, each adapter's `token`/`recipient` resolve, and every resource can emit ≥1 valid offer.
     Fail boot if a resource is unsatisfiable by its own configuration.
   - **Runtime, in `pay()`** — the BUYER's `policy` is client-side and unknown to the server, so
     "this policy matches no offered route" is a `pay()` SELECTION error (a typed `NoAcceptableMethod`
     result carrying per-route filtered-out reasons so the buyer can adjust policy), NOT something the
     server can detect at boot. This is where the Permit2 XOR refusal surfaces.
5. **Derive `gasless`/`requiresApproval`/`trust`** from `(adapter, method, token, wallet state)`;
   `requiresApproval` is wallet-state dependent (existing Permit2 allowance) so it is computed in
   `selectRoute`, not declared.

## Consequences

- **Positive:** one buyer integration (`pay`), one merchant config (`createPaymentGateway`);
  spec-clean (no wire change, no credential added); extensible — a new rail = a new adapter +
  a new standard offer, no buyer/merchant code change. Pure-mpp and pure-x402 clients still
  interoperate with the same 402.
- **Cost / net-new work:** the shared cross-rail idempotency store (Blocker 1), the gateway layer
  itself, the b402 `ProviderAdapter.describeOffers()`, and (for USDT/USDC over b402) a Permit2
  `PaymentPayload` variant + buyer-side b402 Permit2 signer — a sizeable chunk, gated behind the
  witness-spec security work.
- **Irreducibly facilitator-specific (Permit2):** the signed digest (spender + witness differ per
  facilitator), the signing screen a human/agent approves, and the absence of post-hoc failover.
  Keeping b402 gas sponsorship REQUIRES b402 be the signed spender. "Facilitator invisible" means
  absent from the buyer's _source code_, not from the _cryptographic payload_.

## Alternatives considered (rejected)

- **Proprietary unified offer envelope** (`{ paths: [...] }` as the 402 body). Rejected: it becomes
  a 4th non-standard wire only this SDK's clients can parse — violating the design's own "each offer
  keeps its own standard wire" principle. Kept as the SDK's internal logical view only.
- **Two-sided mpp adapter routing b402's spender/witness into the mpp challenge** (an earlier
  proposal in this design thread). Rejected: it would put a b402 witness inside an mpp `permit2`
  payload — exactly the spec violation §4.2.2/§6 forbid.
- **Make the Permit2 signature facilitator-agnostic** via a fixed router-contract spender, a
  merchant-as-spender relay, ERC-4337, or an EIP-3009-only universe with USDT/USDC wrappers. All
  came back `partial` under adversarial review: the router/relay schemes lose b402's gas sponsorship
  (collapse to self-hosting), ERC-4337 requires the buyer be a smart account (a separate
  incompatible integration), and wrappers exclude the very Permit2-only tokens (USDT/USDC) that
  motivate the work. The XOR theorem is structural, not an abstraction gap.

## Phasing

1. **DONE** — the **developer-surface unification** over what exists TODAY: `pay(url, { wallet,
policy })` in [`src/client/pay/`](../../src/client/pay) selects across the mpp credentials
   ONLY (`authorization`/`permit2`/`transaction`/`hash`), single-wire (`Authorization: Payment`), so
   the cross-rail idempotency problem does not yet arise. The pure `deriveLogicalPaths` + `selectRoute`
   (hard-filter → mode-rank → fail-closed) are the design's core, exhaustively unit-tested. There is
   NO standalone `b402:eip3009` / `X-PAYMENT` route yet, and this phase did not add one;
   `allowFacilitator` is therefore NOT part of the Phase-1 `PayPolicy` (it would be a dead switch —
   no facilitator-trust route exists on the mpp wire) and lands with the standalone rail in Phase 2.
2. Add the **gateway + cross-rail idempotency store** (Blocker 1) and the **two-standard-wires 402**,
   introducing the FIRST standalone `b402:eip3009` x402 offer alongside the mpp challenge — this is
   the phase that first makes two rails co-present, so it is gated on the idempotency design.
3. Add the b402 `ProviderAdapter` (its `describeOffers()` emits the x402 eip3009 offer); move
   token/recipient onto adapters (Blocker 2).
4. ONLY if Permit2-over-b402 (USDT/USDC) is a hard requirement: add the Permit2 `PaymentPayload`
   variant + buyer-side b402 Permit2 signer, gated behind a witness-spec HMAC binding extension +
   buyer-side witness allowlist (else "sign what the challenge declares" is a phishing primitive).
