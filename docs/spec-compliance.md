# Spec compliance & extensions

`@bnb-chain/mpp` implements
[`draft-evm-charge-00`](https://paymentauth.org/draft-evm-charge-00.html)
on top of [`mppx@0.8.12`](https://github.com/wevm/mppx) (commit
[`b4334f0`](https://github.com/wevm/mppx/tree/b4334f0f0683930a1c9061d78de3a5255caaf962)).

This document lists where the SDK extends or makes choices the draft
leaves open. There is exactly **one wire extension** (`permit2Spender`).
Everything else stays within the draft's letter, but several entries
under [Compliance choices](#compliance-choices) are deliberate
deviations from a SHOULD, stricter-than-spec validation, or a documented
resolution of a spec contradiction — read them before assuming
"vanilla draft" interop behaviour.

## Extension: `methodDetails.permit2Spender`

**Status:** wire extension — not defined by `draft-evm-charge-00`,
required for `permit2` settlement.
**ADR:** [`adr/0001-permit2-spender.md`](adr/0001-permit2-spender.md).

### Why it exists

Permit2's `SignatureTransfer` reconstructs the EIP-712 hash using
`msg.sender` as the `spender` field — it is NOT a signed parameter:

```solidity
// Uniswap/permit2 — src/libraries/PermitHash.sol
function hash(ISignatureTransfer.PermitTransferFrom memory permit) internal view returns (bytes32) {
    bytes32 tokenPermissionsHash = _hashTokenPermissions(permit.permitted);
    return keccak256(
        abi.encode(_PERMIT_TRANSFER_FROM_TYPEHASH, tokenPermissionsHash,
                   msg.sender,            // ← the spender, hardcoded
                   permit.nonce, permit.deadline)
    );
}
```

So the payer MUST sign the Permit2 typed data with `spender = the address
that will call permitWitnessTransferFrom on-chain` = the server's
settlement signer. Signing with anything else (e.g. the Permit2 contract
address) produces a signature that recovers fine locally but reverts
`InvalidSigner()` (selector `0x815e1d64`) at settlement.

The draft is silent on this (its `methodDetails` table —
`chainId` / `permit2Address` / `credentialTypes` / `decimals` / `splits` —
has no spender field, and §6.1 doesn't show the signed `spender`). The
client therefore has no spec-sanctioned way to learn the settlement
signer's address. The SDK closes the gap by publishing it.

### Wire contract

| Field            | Type   | Required                                             | Description                                                       |
| ---------------- | ------ | ---------------------------------------------------- | ----------------------------------------------------------------- |
| `permit2Spender` | string | OPTIONAL on wire; REQUIRED for `permit2` credentials | Settlement signer EOA = `msg.sender` at the on-chain Permit2 call |

- **Server**: `preflightCharge` derives it from
  `settlementAccount.address` and `charge()` injects it into
  `defaults.methodDetails.permit2Spender` (only when a settlement signer
  is configured). It is bound into the challenge HMAC (mppx Tier-1 covers
  the full serialized request via the challenge `id`; the SDK's
  `stableBinding` Tier-2 also pins it explicitly).
- **Client**: `createPermit2Credential` reads
  `challenge.request.methodDetails.permit2Spender` and signs the EIP-712
  typed data with it. A challenge missing the field is a hard error
  (issued by a server pre-dating this fix → can't produce a settleable
  credential).
- **Verifier**: `verifyPermit2` requires the field, cross-checks it
  equals `ctx.settlementSigner.account.address` (rejects a tampered
  challenge that tries to redirect the spender), and uses it for both
  EIP-712 recovery and the on-chain call.

Affects only the `permit2` path. `hash` / `transaction` / `authorization`
do not have the `msg.sender` constraint (EIP-3009 binds `from`→`to` in the
signed payload; anyone may relay it).

Naming follows the [quiknode-labs/mpp](https://github.com/quiknode-labs/mpp)
convention.

## Compliance choices

### Challenge binding

`challengeBinding.mode` on `ServerParameters` — `mppx-managed` /
`mppx-hmac` / `stored-lookup`. See
[architecture.md](architecture.md#challenge-binding-modes). `stored-lookup`
is `draft §6` zero-deviation (constant-time compare against a persisted
snapshot, no server secret).

### Receipt compatibility (`draft §7.6`)

The receipt carries `method` / `challengeId` / `reference` / `status` /
`timestamp` / `chainId` (+ optional `externalId`). mppx 0.8.12 uses a
loose `Receipt.Schema`, so its standard transport preserves method-specific
fields and `charge()` no longer overrides the host transport. The SDK keeps
`buildEvmReceipt` and its browser-safe codec for the stronger EVM-specific
type and runtime validation. `evmHttpTransport` is optional for custom hosts
that want a fail-closed assertion at the transport boundary.

### v1 token support

- Curated token presets only — no arbitrary BYO ERC-20. `currency` on the
  wire is always the resolved curated address.
- Preset names mean the **native issuer's** token only. Bridged / wrapped
  variants must use a distinct preset name (e.g. no `(bsc, USDC)` — BSC
  has no Circle-native USDC).
- `authorization` is advertised only for `(chain, token)` pairs whose
  curated entry has `eip3009Supported: true` (with a verified EIP-712
  `name` / `version`).
- `TEST_USDT` is testnet-only and must never appear in a mainnet matrix
  entry or be treated as Tether-official.

See the [Tokens](../README.md#tokens) table for the current matrix and
the per-preset semantics.

### `credentialTypes` default ordering (draft §4.2.2 SHOULD deviation)

Draft §4.2.2: "Servers that support Permit2 SHOULD include `permit2` as
the first entry to indicate preference." The SDK deviates for EIP-3009
tokens: `getAcceptedCredentialTypes` (`src/server/curated.ts`) returns

- `['authorization', 'permit2', 'transaction', 'hash']` for
  `(chain, token)` pairs with `eip3009Supported: true` — authorization
  first because it is the most gas-efficient path for the payer (a
  single on-chain settlement, signed once);
- `['permit2', 'transaction', 'hash']` otherwise — permit2 first per
  the SHOULD (still 1-tx for the payer).

The order is semantic (clients SHOULD pick the first type they support,
draft Table 2) and the server's request hook rejects route overrides
that reorder or substitute the resolved array.

### Strict wire schema: positive `amount`, `decimals` ≤ 36

`src/Methods.ts` (the single wire schema shared by server AND client) is
stricter than draft §4.1 Table 1 / §4.2 Table 2 in two places:

- **`amount` must be a positive base-units integer string** — the regex
  `/^[1-9]\d*$/` rejects `'0'`, leading zeros, and decimal points.
  Table 1 only says "Amount in base units (stringified integer)", which
  literally admits `'0'`.
- **`decimals` is capped at 36** — Table 2 places no upper bound
  (ERC-20 `decimals()` is a uint8, 0–255). Real stablecoins top out at
  18; a value above 36 is almost certainly a wei/gwei confusion, so the
  schema rejects it.

Because the same schema parses inbound challenges on the client, these
constraints also apply to **third-party challenges**: a challenge from
another implementation carrying `amount: "0"` or `decimals: 40` fails
schema parse in this SDK's client.

### `credential.source` REQUIRED for `permit2` (draft Table 4 deviation)

Draft Table 4 marks the credential envelope's `source` field OPTIONAL.
The SDK **requires** it for `permit2` credentials: §6.1 step 1 says the
EIP-712 signature must be "valid and recover[…] to the source address",
which makes `source` the verification's identity anchor — viem's
recovery is math-only and returns _some_ address even for a garbage
signature, so without `source` there is nothing to compare the
recovered signer against. `verifyPermit2` (`src/server/Permit2.ts`,
step 11) rejects a permit2 credential that omits it. For
`authorization` / `transaction` the payload itself carries the
authoritative identity, so `source` stays optional there — but is
cross-checked whenever present.

### `credential.source` accepts only `did:pkh:eip155`

The draft only SHOULD-recommends the `did:pkh` method ("The source
field, if present, SHOULD use the did:pkh method…"). The SDK
hard-requires the exact format `did:pkh:eip155:{chainId}:{address}` —
any other DID method (`did:key`, `did:web`, …) is **rejected**, not
ignored (`assertDidPkhSourceMatches` in
`src/server/charge/verifierKit.ts`). Rationale: a `source` the verifier
cannot decode cannot be compared against the recovered signer, and
silently skipping the check would downgrade the §6.1 binding.

### §5.2.3 witness type-string whitespace erratum

The July 2026 draft now normatively defines
`PaymentWitness { bytes32 challengeHash; string externalId; }` and requires
the empty string when `externalId` is absent. The SDK implements that wire
shape on the client, server, schema, frozen vectors, and Permit2 hashStruct.

The prose's quoted `witnessTypeString` contains a space after the comma:
`PaymentWitness(bytes32 challengeHash, string externalId)`. EIP-712
`encodeType`, including viem and Solidity implementations, canonicalizes
adjacent fields without that space:
`PaymentWitness(bytes32 challengeHash,string externalId)`. Passing the prose
literal to Permit2 would make its on-chain type hash differ from the wallet's
EIP-712 signature. `PERMIT2_WITNESS_TYPE_STRING` therefore uses the canonical
no-space form. This is a narrow interoperability correction to the draft
literal, covered by frozen typed-data and viem cross-check vectors.

### `hashFromPolicy: 'strict_from'` is a consistency check, not submitter authentication

The opt-in `strict_from` policy (`src/server/Hash.ts`, step 6) requires
`credential.source` and checks it equals the on-chain `Transfer.from`.
That is a consistency check between what the credential claims and what
happened on-chain — it does **not** authenticate the HTTP submitter:
anyone who observes a tx hash on a public chain can read
`Transfer.from` from the receipt and construct a matching `source`. It
therefore does not close §10.4's hash-credential binding weakness ("the
server … cannot prove the payment was created for a specific challenge
instance"). Operators who need real challenge binding should follow
§10.4's MAY mitigations instead: prefer `permit2` / `authorization`
ordering in `credentialTypes`, or restrict `hash` to low-value charges.

### EIP-55 wire encoding (draft §4.1 SHOULD)

Addresses the server emits on the wire (`currency`, `recipient`,
`methodDetails.permit2Address`, `permit2Spender`, `splits[].recipient`)
are EIP-55 checksummed via viem `getAddress`
(`src/server/charge/defaults.ts`), per §4.1's "Implementations SHOULD
use EIP-55 mixed-case encoding". Inbound, the schema accepts any casing
(no EIP-55 enforcement) and every comparison stays case-insensitive by
decoded 20-byte value per §4.1's MUST — the checksumming is
wire-cosmetic only.

**Upgrade note (pre→post EIP-55 casing):** "wire-cosmetic" holds for
every verifier comparison, but the `mppx-hmac` and `stored-lookup`
challenge-binding modes byte-compare the **serialized request** — a
challenge issued by a pre-EIP-55 server (lowercase addresses on the
wire) re-presented to a post-EIP-55 server serializes differently and
fails binding. The window is transient: it only affects challenges
IN-FLIGHT across the upgrade and is bounded by challenge expiry
(typically ~5 min). Harmless for v0.1.0 — the pre-casing builds were
never released, so no live deployment can hold a pre-upgrade
challenge.

### `validBefore` ↔ `challenge.expires` binding (draft §5.3.2 SHOULD)

§5.3.2: "validBefore SHOULD correspond to the challenge expires
timestamp." The SDK enforces this from both sides:

- **Client** (`src/client/Authorization.ts`) — `validBefore` defaults
  to the challenge's `expires` timestamp, capped at `now + 600`
  seconds (plain `now + 600` when the challenge carries no `expires`).
- **Server** (`src/server/Authorization.ts`) — rejects an authorization
  whose `validBefore` exceeds `challenge.expires` by more than a 600 s
  tolerance (`VALID_BEFORE_TOLERANCE_SEC`). A `validBefore` far beyond
  `expires` would leave a signed, anyone-can-submit transfer redeemable
  on-chain long after the challenge window closed. The tolerance
  accommodates clients that sign a fixed `now+10min` window against a
  typical ~5 min challenge expiry.

### Replay protection (`spec §9`)

3-state atomic store; durable backend required in production. See
[replay-store.md](replay-store.md).
