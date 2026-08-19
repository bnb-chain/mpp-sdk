/**
 * Wire allowlist output schema for the EVM Charge method.
 *
 * Single source of truth for both server (`@bnb-chain/mpp/server`) and client
 * (`@bnb-chain/mpp/client`). Methods.ts defines what an EVM Charge request /
 * credential looks like *on the wire* — it does NOT define defaults, RPC
 * resolution, or settlement. Those are the server factory's job (§10).
 *
 * Semantic of "wire allowlist output schema" (spec §6.1.0):
 *   - REQUIRED fields throw on parse if missing (e.g. methodDetails.permit2Address)
 *   - Unknown fields are silently stripped by zod-mini default (e.g. feePayer,
 *     settlementAccount, rpcUrl all disappear before wire serialization)
 *
 * Naming: this Method instance is `chargeMethod`. The server-side factory
 * `charge()` lives in `src/server/Charge.ts`, and the client-side factory
 * `charge()` lives in `src/client/Charge.ts` — both are functions sharing the
 * lowercase `charge` name within their respective package entry. We keep
 * `chargeMethod` for the Method instance itself to avoid ambiguity in code
 * that imports both.
 */

import { Method, z } from 'mppx'

/* -------------------------------------------------------------------------- */
/*  Credential type union                                                     */
/* -------------------------------------------------------------------------- */

export const credentialTypes = ['permit2', 'authorization', 'transaction', 'hash'] as const
export type CredentialType = (typeof credentialTypes)[number]

/* -------------------------------------------------------------------------- */
/*  Local schema helpers                                                      */
/*                                                                            */
/*  Each helper below has an mppx equivalent (z.amount / z.hash / z.address / */
/*  z.signature). We deliberately keep local definitions to lock the wire     */
/*  semantics against mppx version drift. See the comment blocks below for    */
/*  per-helper rationale.                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Length cap for decimal-string uint256 fields (amounts, nonces, unix-time
 * bounds). uint256's maximum value is 78 decimal digits; anything longer is
 * structurally invalid AND a DoS vector (audit M04): V8's decimal-string →
 * BigInt conversion is super-linear in length, so an unbounded field lets an
 * unauthenticated request freeze the event loop for seconds (measured: ~5s
 * at 50M digits). The cap must run BEFORE any `BigInt(...)` on wire input.
 */
const UINT256_MAX_DECIMAL_DIGITS = 78

/**
 * Base-units stringified *positive* integer. Used for any amount field on the
 * wire (top-level `amount`, `permit.permitted[].amount`,
 * `transferDetails[].requestedAmount`, `authorization.value`,
 * `splits[].amount`).
 *
 * ⚠️ Do NOT use mppx `z.amount()`. Its internal regex is `/^\d+(\.\d+)?$/`,
 *    which allows decimal strings like "1.5" — that violates draft-evm-charge-00
 *    §4.1's base-units integer requirement. See mppx src/zod.ts amount()
 *    helper (mppx 0.8.12, commit b4334f0).
 */
const positiveBaseUnitAmount = z
  .string()
  .check(
    z.maxLength(UINT256_MAX_DECIMAL_DIGITS),
    z.regex(/^[1-9]\d*$/, 'amount must be base-units stringified positive integer'),
  )

/**
 * Raw signed transaction bytes for the `transaction` credential (0x-prefixed
 * hex). Bounded (audit M04): the verifier's FIRST step feeds this into viem's
 * parseTransaction → recoverTransactionAddress → keccak256, all of which
 * scale with byte length (measured: ~3.8s total at ~23MB). 128 KB of raw tx
 * (0x + 262144 hex chars) is orders of magnitude above any legitimate ERC-20
 * transfer envelope (a few hundred bytes) while keeping the worst-case parse
 * cost in the low milliseconds.
 */
const rawSignedTransactionHex = z
  .string()
  .check(z.maxLength(262146), z.regex(/^0x[0-9a-fA-F]+$/, 'expected 0x-prefixed hex string'))

/**
 * 0x-prefixed 32-byte hex string. mppx `z.hash()` is equivalent (confirmed
 * against mppx 0.8.12 commit b4334f0 src/zod.ts), but we keep a local definition so the
 * wire shape doesn't drift with future mppx releases.
 */
const bytes32 = z.string().check(z.regex(/^0x[0-9a-fA-F]{64}$/, 'expected 0x-prefixed 32-byte hex'))

/** Alias for bytes32 used where readers expect a tx hash. */
const txHash = bytes32

/**
 * 0x-prefixed 20-byte EVM address. mppx `z.address()` is equivalent
 * (0x + 40 hex, case-insensitive accepted, no EIP-55 enforcement —
 * confirmed against mppx 0.8.12 commit b4334f0 src/zod.ts).
 *
 * We keep a local definition so:
 *   - draft-evm-charge-00's "decoded 20-byte compare" semantics are explicit
 *     here (EIP-55 is SHOULD, not MUST — server must not reject lowercase);
 *   - downstream comparisons can rely on a stable wire shape if mppx ever
 *     tightens z.address() behaviour upstream.
 *
 * All downstream comparisons MUST `.toLowerCase()` on both sides before
 * `===` — there is no schema-level transform to normalize.
 */
const evmAddress = z
  .string()
  .check(z.regex(/^0x[0-9a-fA-F]{40}$/, 'expected 0x-prefixed 20-byte address'))

/**
 * 0x-prefixed secp256k1 signature. Accepts both EIP-2098 compact (64 bytes /
 * 128 hex) and standard r||s||v (65 bytes / 130 hex).
 *
 * ⚠️ Do NOT use mppx `z.signature()`. Its internal regex is `^0x[0-9a-fA-F]+$`
 *    — any hex length passes, including "0xabcdef" (confirmed against
 *    mppx 0.8.12 commit b4334f0 src/zod.ts). That's too loose for EVM Charge, where
 *    permit2 / EIP-3009 signatures MUST be 64 or 65 bytes.
 */
const evmSignature = z
  .string()
  .check(
    z.regex(
      /^0x([0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/,
      'expected 0x-prefixed 64-byte (EIP-2098) or 65-byte (r||s||v) hex signature',
    ),
  )

/* -------------------------------------------------------------------------- */
/*  methodDetails: REQUIRED on the wire                                       */
/* -------------------------------------------------------------------------- */

/**
 * EVM Charge methodDetails. Both `chainId` and `permit2Address` are REQUIRED
 * (draft §6.3) — schema.parse() throws if either is missing. Public callers
 * MUST omit-via-defaults (server factory's `defaults` parameter), NOT
 * omit-via-schema.
 */
const methodDetails = z.object({
  // EIP-155 chainId: positive integer, within Number safe range. Chains
  // requiring chainId > 2^53 - 1 (none currently exist) would need a bigint
  // extension — out of scope for v1 (see spec §20.3).
  //
  // zod-mini has no .int() chain helper — express the integer constraint via
  // z.refine(Number.isInteger). Range bounds use z.positive() + z.lte().
  chainId: z
    .number()
    .check(
      z.refine(Number.isInteger, 'chainId must be an integer'),
      z.positive(),
      z.lte(Number.MAX_SAFE_INTEGER),
    ),
  permit2Address: evmAddress,
  /**
   * Permit2 spender — the EOA that will call `permitWitnessTransferFrom`
   * on Permit2. MUST equal `msg.sender` at settlement time, because
   * Permit2's `PermitHash._hashWithWitness` uses `msg.sender` as the
   * `spender` field when reconstructing the EIP-712 hash — see
   * https://github.com/Uniswap/permit2/blob/main/src/libraries/PermitHash.sol#L51-L60
   *
   * REQUIRED for `permit2` credentials so the client can sign typed data
   * with the correct `spender`. OPTIONAL for `hash` / `transaction` /
   * `authorization` credentials (EIP-3009 doesn't have the msg.sender
   * constraint — signature ties from→to directly).
   *
   * Server factories inject this automatically from
   * `ServerParameters.settlementAccount.address`. Spec extension matching
   * quiknode-labs/mpp convention (draft-evm-charge-00 is silent on this
   * field even though Permit2 architecturally requires it).
   */
  permit2Spender: z.optional(evmAddress),
  credentialTypes: z.optional(z.array(z.enum(credentialTypes)).check(z.minLength(1))),
  // ERC-20 decimals is uint8 (0-255) per standard. We cap at 36 since real
  // stablecoins top out at 18; values above 36 are almost certainly a
  // wei/gwei confusion.
  decimals: z.optional(
    z
      .number()
      .check(z.refine(Number.isInteger, 'decimals must be an integer'), z.gte(0), z.lte(36)),
  ),
  splits: z.optional(
    z
      .array(
        z.object({
          recipient: evmAddress,
          amount: positiveBaseUnitAmount,
          memo: z.optional(z.string().check(z.maxLength(256))),
        }),
      )
      .check(z.minLength(1), z.maxLength(10)),
  ),
})

/* -------------------------------------------------------------------------- */
/*  request: top-level wire shape                                             */
/* -------------------------------------------------------------------------- */

const requestObject = z.object({
  amount: positiveBaseUnitAmount,
  currency: evmAddress,
  recipient: evmAddress,
  description: z.optional(z.string()),
  externalId: z.optional(z.string()),
  methodDetails,
})

/**
 * Request with cross-field check: `sum(splits[].amount) < amount`. The strict
 * `<` (not `<=`) is per draft §4.2.3 — the difference accrues to the primary
 * recipient. If no splits, the check trivially passes.
 *
 * Note: amounts here are already base-units integers (the schema rejected
 * decimals upstream), so we compare via BigInt directly. No parseUnits needed.
 */
const request = requestObject.check(
  z.refine(({ amount, methodDetails: md }) => {
    if (!md.splits) return true
    const total = BigInt(amount)
    const splitSum = md.splits.reduce((sum, s) => sum + BigInt(s.amount), 0n)
    return splitSum < total
  }, 'sum(splits[].amount) must be strictly less than amount (draft §4.2.3)'),
)

/* -------------------------------------------------------------------------- */
/*  credential payload: discriminated union over `type`                       */
/* -------------------------------------------------------------------------- */

const credentialPayload = z.discriminatedUnion('type', [
  // —— permit2 (single OR batch — discriminated at runtime by length) ——
  z.object({
    type: z.literal('permit2'),
    permit: z.object({
      permitted: z
        .array(z.object({ token: evmAddress, amount: positiveBaseUnitAmount }))
        .check(z.minLength(1)),
      // Permit2 nonce is uint256 — serialized as decimal string on the wire.
      nonce: z
        .string()
        .check(
          z.maxLength(UINT256_MAX_DECIMAL_DIGITS),
          z.regex(/^\d+$/, 'permit2 nonce must be decimal uint256 string'),
        ),
      // Permit2 deadline is unix seconds — also decimal string.
      deadline: z
        .string()
        .check(
          z.maxLength(UINT256_MAX_DECIMAL_DIGITS),
          z.regex(/^\d+$/, 'permit2 deadline must be unix seconds decimal string'),
        ),
    }),
    transferDetails: z
      .array(z.object({ to: evmAddress, requestedAmount: positiveBaseUnitAmount }))
      .check(z.minLength(1)),
    witness: z.object({ challengeHash: bytes32, externalId: z.string() }),
    signature: evmSignature,
  }),
  // —— authorization (EIP-3009 transferWithAuthorization) ——
  z.object({
    type: z.literal('authorization'),
    from: evmAddress,
    to: evmAddress,
    value: positiveBaseUnitAmount,
    // EIP-3009 validAfter / validBefore are unix seconds — decimal string.
    validAfter: z
      .string()
      .check(
        z.maxLength(UINT256_MAX_DECIMAL_DIGITS),
        z.regex(/^\d+$/, 'validAfter must be unix seconds decimal string'),
      ),
    validBefore: z
      .string()
      .check(
        z.maxLength(UINT256_MAX_DECIMAL_DIGITS),
        z.regex(/^\d+$/, 'validBefore must be unix seconds decimal string'),
      ),
    // EIP-3009 nonce is a 32-byte opaque identifier (NOT a counter).
    nonce: bytes32,
    signature: evmSignature,
  }),
  // —— transaction (full EIP-1559 RLP) ——
  z.object({
    type: z.literal('transaction'),
    // Raw signed transaction bytes (0x-prefixed hex). Length varies with
    // calldata / typed-tx envelope; capped at 128 KB (audit M04 — see
    // rawSignedTransactionHex). Verifier (§8.3) parses via
    // viem.parseTransaction.
    signature: rawSignedTransactionHex,
  }),
  // —— hash ——
  z.object({
    type: z.literal('hash'),
    hash: txHash,
  }),
])

/* -------------------------------------------------------------------------- */
/*  chargeMethod                                                              */
/* -------------------------------------------------------------------------- */

export const chargeMethod = Method.from({
  name: 'evm', // draft-evm-charge-00 §1.1 — MUST be 'evm'
  intent: 'charge',
  schema: {
    credential: { payload: credentialPayload },
    request,
  },
})
