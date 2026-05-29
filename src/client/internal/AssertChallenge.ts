/**
 * Client-side challenge validation helpers.
 *
 * Three layered helpers, used by every credential constructor in
 * `@bnb-chain/mpp/client`:
 *
 *   1. `parseEvmChargeChallenge(challenge)` — checks `method` / `intent`
 *      identify an EVM Charge challenge, then runs `challenge.request`
 *      through `chargeMethod.schema.request.parse` for ground truth.
 *      Returns the parsed request. (Was previously just
 *      `chargeMethod.schema.request.parse` with no method/intent guard,
 *      so a wrong-method challenge wouldn't be caught client-side.)
 *
 *   2. `assertCredentialTypeAccepted(parsed, type)` — checks `type` is
 *      in `parsed.methodDetails.credentialTypes ?? ['transaction', 'hash']`.
 *      Spec §4.2.2 / §6.3: when the server omits `credentialTypes`, the
 *      client MUST treat the accepted set as `['transaction', 'hash']`
 *      only — `permit2` / `authorization` require explicit server opt-in.
 *      (Previously every constructor trusted its own type
 *      was accepted, so e.g. a Permit2 caller would happily sign against
 *      a challenge that advertised only `['hash']`.)
 *
 *   3. `assertMatchesChallengeRequest(parsed, expected)` — caller-supplied
 *      wire fields (chainId/currency/recipient/amount/permit2Address) MUST
 *      equal `parsed.*`. Throws with a per-field mismatch message.
 *
 * Each constructor calls these in order:
 *   parsed = parseEvmChargeChallenge(challenge)
 *   assertCredentialTypeAccepted(parsed, '<own type>')
 *   assertMatchesChallengeRequest(parsed, { ...opts })
 *
 * The split exists so the per-constructor accepted check happens BEFORE
 * the per-field compare; if a Permit2 caller's chainId is wrong AND
 * Permit2 isn't accepted, the more-actionable "not accepted" error fires.
 */

import { type Challenge } from 'mppx'

import { type CredentialType, chargeMethod } from '../../Methods.js'

/**
 * The validated wire shape of an EVM Charge `challenge.request`. Mirrors
 * the relevant slice of `chargeMethod.schema.request` (the parts the
 * client constructors compare against).
 */
export interface ParsedEvmChargeRequest {
  readonly amount: string
  readonly currency: string
  readonly recipient: string
  readonly description?: string
  readonly externalId?: string
  readonly methodDetails: {
    readonly chainId: number
    readonly permit2Address: string
    /**
     * Permit2 spender — settlement-signer EOA that will call
     * `permitWitnessTransferFrom` (`msg.sender` at on-chain Permit2 call
     * time). REQUIRED for permit2 credentials so the client signs typed
     * data with the correct `spender` — Permit2 hashes `msg.sender` as
     * the spender field, NOT the Permit2 contract address. Server SDKs
     * inject from `settlementAccount.address` in preflightCharge. Spec
     * extension matching quiknode-labs/mpp convention.
     */
    readonly permit2Spender?: string
    readonly credentialTypes?: readonly CredentialType[]
    readonly decimals?: number
    readonly splits?: ReadonlyArray<{
      readonly recipient: string
      readonly amount: string
      readonly memo?: string
    }>
  }
}

/**
 * Full client-side challenge validator.
 *
 * Rejects:
 *   - `challenge.method !== chargeMethod.name`  (e.g. tempo / 'l402' / 'evm-typo')
 *   - `challenge.intent !== chargeMethod.intent`
 *   - `challenge.request` failing `chargeMethod.schema.request.parse`
 *
 * Returns the parsed (= wire-truth) request so downstream helpers don't
 * re-parse.
 */
export function parseEvmChargeChallenge(challenge: Challenge.Challenge): ParsedEvmChargeRequest {
  if (challenge.method !== chargeMethod.name) {
    throw new Error(
      `parseEvmChargeChallenge: expected challenge.method='${chargeMethod.name}', ` +
        `got '${challenge.method}'. This challenge is not an EVM Charge — pick a ` +
        `different builder for its method.`,
    )
  }
  if (challenge.intent !== chargeMethod.intent) {
    throw new Error(
      `parseEvmChargeChallenge: expected challenge.intent='${chargeMethod.intent}', ` +
        `got '${challenge.intent}'.`,
    )
  }
  try {
    return chargeMethod.schema.request.parse(challenge.request) as ParsedEvmChargeRequest
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new Error(
      `parseEvmChargeChallenge: challenge.request failed chargeMethod.schema.request.parse — ` +
        `caller passed a malformed EVM Charge challenge. Underlying: ${reason}`,
      { cause },
    )
  }
}

/**
 * Assert that `type` is in the challenge's accepted credential
 * set. Spec §4.2.2 / §6.3 define the default when `credentialTypes` is
 * absent: only `['transaction', 'hash']`. `permit2` / `authorization`
 * MUST be explicitly advertised by the server.
 */
export function assertCredentialTypeAccepted(
  parsed: ParsedEvmChargeRequest,
  type: CredentialType,
): void {
  const accepted: readonly CredentialType[] =
    parsed.methodDetails.credentialTypes ?? (['transaction', 'hash'] as const)
  if (!accepted.includes(type)) {
    throw new Error(
      `assertCredentialTypeAccepted: '${type}' is not in the challenge's accepted ` +
        `credential set [${accepted.join(', ')}]. ` +
        (parsed.methodDetails.credentialTypes === undefined
          ? `(challenge omitted methodDetails.credentialTypes — per spec §4.2.2 / §6.3 ` +
            `the client default accepted set is ['transaction', 'hash'] only; ` +
            `permit2 / authorization require explicit server opt-in.)`
          : `Pick one of the accepted types and call the matching constructor.`),
    )
  }
}

/* -------------------------------------------------------------------------- */
/*  Per-field mismatch guard                                                   */
/* -------------------------------------------------------------------------- */

interface ExpectedRequestFields {
  readonly chainId: number
  readonly currency: `0x${string}`
  readonly recipient: `0x${string}`
  readonly amount: string | bigint
  /** Permit2-only — for hash/authorization/transaction this stays undefined. */
  readonly permit2Address?: `0x${string}`
}

/**
 * Throws `Error` if any `expected.*` value disagrees with the parsed
 * wire-truth request. Returns silently on a clean match.
 *
 * Takes the ALREADY-parsed request (from `parseEvmChargeChallenge`) so
 * the parse doesn't happen twice per credential-construction call.
 */
export function assertMatchesChallengeRequest(
  parsed: ParsedEvmChargeRequest,
  expected: ExpectedRequestFields,
): void {
  if (expected.chainId !== parsed.methodDetails.chainId) {
    throw new Error(
      `assertMatchesChallengeRequest: 'chainId' mismatch — caller ${expected.chainId} ` +
        `vs challenge.request.methodDetails.chainId ${parsed.methodDetails.chainId}`,
    )
  }
  if (expected.currency.toLowerCase() !== parsed.currency.toLowerCase()) {
    throw new Error(
      `assertMatchesChallengeRequest: 'currency' mismatch — caller ${expected.currency} ` +
        `vs challenge.request.currency ${parsed.currency}`,
    )
  }
  if (expected.recipient.toLowerCase() !== parsed.recipient.toLowerCase()) {
    throw new Error(
      `assertMatchesChallengeRequest: 'recipient' mismatch — caller ${expected.recipient} ` +
        `vs challenge.request.recipient ${parsed.recipient}`,
    )
  }
  let callerAmount: bigint
  try {
    callerAmount = BigInt(expected.amount)
  } catch {
    throw new Error(
      `assertMatchesChallengeRequest: caller 'amount' (${String(expected.amount)}) is not parseable as bigint`,
    )
  }
  const wireAmount = BigInt(parsed.amount)
  if (callerAmount !== wireAmount) {
    throw new Error(
      `assertMatchesChallengeRequest: 'amount' mismatch — caller ${callerAmount} ` +
        `vs challenge.request.amount ${wireAmount}`,
    )
  }
  if (expected.permit2Address !== undefined) {
    if (
      expected.permit2Address.toLowerCase() !== parsed.methodDetails.permit2Address.toLowerCase()
    ) {
      throw new Error(
        `assertMatchesChallengeRequest: 'permit2Address' mismatch — caller ${expected.permit2Address} ` +
          `vs challenge.request.methodDetails.permit2Address ${parsed.methodDetails.permit2Address}`,
      )
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Splits source-of-truth helpers                                             */
/* -------------------------------------------------------------------------- */

/**
 * Assert a non-Permit2 constructor isn't trying to fulfill a
 * splits-bearing challenge. Spec §4.2.3 / §10: splits MUST only be
 * fulfilled by `permit2` (single batch transaction with N+1 entries);
 * any other type would necessarily under- or over-pay one of the splits.
 *
 * Hash / Authorization / Transaction constructors call this with their
 * own type name so the error message is actionable.
 */
export function assertNoSplitsForNonPermit2(
  parsed: ParsedEvmChargeRequest,
  type: Exclude<CredentialType, 'permit2'>,
): void {
  if (parsed.methodDetails.splits !== undefined) {
    throw new Error(
      `assert${type[0]!.toUpperCase()}${type.slice(1)}NoSplits: challenge.request.methodDetails.splits ` +
        `is set (${parsed.methodDetails.splits.length} entries) but '${type}' credentials ` +
        `cannot fulfill splits (spec §4.2.3 — only permit2 batch transfers can). Either drop ` +
        `splits from the challenge or use createPermit2Credential.`,
    )
  }
}

/**
 * Source-of-truth helper for Permit2 splits. Returns the
 * challenge's splits (canonical) and verifies any caller-supplied
 * `opts.splits` deep-equals them.
 *
 * Returns an empty array when the challenge has no splits (single-permit
 * path), regardless of whether the caller passed an empty `opts.splits`.
 */
export interface SplitInput {
  readonly recipient: `0x${string}`
  readonly amount: string | bigint
  readonly memo?: string
}

export interface ResolvedSplit {
  readonly recipient: `0x${string}`
  readonly amount: string
  readonly memo?: string
}

export function resolvePermit2Splits(
  parsed: ParsedEvmChargeRequest,
  callerSplits: ReadonlyArray<SplitInput> | undefined,
): ReadonlyArray<ResolvedSplit> {
  const wireSplits = parsed.methodDetails.splits ?? []

  // Caller didn't supply splits — fall back to wire truth (canonical).
  if (callerSplits === undefined) {
    return wireSplits.map((s) => ({
      recipient: s.recipient as `0x${string}`,
      amount: s.amount,
      ...(s.memo !== undefined && { memo: s.memo }),
    }))
  }

  // Caller supplied splits — deep-equal against wire truth.
  if (callerSplits.length !== wireSplits.length) {
    throw new Error(
      `resolvePermit2Splits: opts.splits.length (${callerSplits.length}) does not match ` +
        `challenge.request.methodDetails.splits.length (${wireSplits.length}). Splits MUST ` +
        `come from the challenge — pass them through unchanged, or omit and let the SDK ` +
        `read from the challenge directly.`,
    )
  }
  const out: ResolvedSplit[] = []
  for (let i = 0; i < callerSplits.length; i++) {
    const c = callerSplits[i]!
    const w = wireSplits[i]!
    if (c.recipient.toLowerCase() !== w.recipient.toLowerCase()) {
      throw new Error(
        `resolvePermit2Splits: opts.splits[${i}].recipient (${c.recipient}) does not match ` +
          `challenge.request.methodDetails.splits[${i}].recipient (${w.recipient})`,
      )
    }
    let cAmount: bigint
    try {
      cAmount = BigInt(c.amount)
    } catch {
      throw new Error(
        `resolvePermit2Splits: opts.splits[${i}].amount (${String(c.amount)}) is not parseable as bigint`,
      )
    }
    if (cAmount !== BigInt(w.amount)) {
      throw new Error(
        `resolvePermit2Splits: opts.splits[${i}].amount (${cAmount}) does not match ` +
          `challenge.request.methodDetails.splits[${i}].amount (${w.amount})`,
      )
    }
    const callerMemo = c.memo
    const wireMemo = w.memo
    if (callerMemo !== wireMemo) {
      throw new Error(
        `resolvePermit2Splits: opts.splits[${i}].memo (${JSON.stringify(callerMemo)}) does not ` +
          `match challenge.request.methodDetails.splits[${i}].memo (${JSON.stringify(wireMemo)})`,
      )
    }
    out.push({
      recipient: w.recipient as `0x${string}`,
      amount: w.amount,
      ...(w.memo !== undefined && { memo: w.memo }),
    })
  }
  return out
}
