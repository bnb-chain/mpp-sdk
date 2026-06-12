/**
 * Permit2 credential constructor (client side, spec §6.1).
 *
 * Signs an EIP-712 Permit2 `PermitWitnessTransferFrom` (single) or
 * `PermitBatchWitnessTransferFrom` (batch, for splits) typed-data
 * structure, wraps the signature + permit / transferDetails / witness
 * into a Permit2 credential, and returns the serialized credential
 * string that is the COMPLETE `Authorization` header value (already
 * includes the `Payment ` scheme prefix — pass as
 * `headers: { Authorization: credential }`).
 *
 * Single vs batch is auto-detected by the presence of `splits`:
 *   - No splits → single permit. `permitted.length === transferDetails.length === 1`.
 *   - Splits → batch permit. `permitted` + `transferDetails` each get
 *     `1 + splits.length` entries; index 0 is the primary recipient,
 *     index i+1 is split[i].
 *
 * The server (`verifyPermit2`, §8.1) enforces equality between every
 * `permitted[i].amount` and `transferDetails[i].requestedAmount` (after
 * the `>=` check), so this client uses exact-match by default; pass
 * `permittedUpperBounds` only if you need server-side slack (rare).
 *
 * `credential.source` is REQUIRED for Permit2 (draft §6.1 normative) —
 * this function auto-derives it from `account.address` + `chainId`.
 */

import { type Challenge, Credential } from 'mppx'
import { type LocalAccount } from 'viem'

import {
  computeChallengeHash,
  permit2BatchTypes,
  permit2Domain,
  permit2SingleTypes,
} from '../protocol/TypedData.js'
import { CANONICAL_PERMIT2_ADDRESS } from '../protocol/Version.js'
import {
  assertCredentialTypeAccepted,
  assertMatchesChallengeRequest,
  parseEvmChargeChallenge,
  resolvePermit2Splits,
} from './internal/AssertChallenge.js'

export interface Permit2Split {
  /** Recipient of this split. */
  readonly recipient: `0x${string}`
  /** Amount (base units) routed to this split. */
  readonly amount: string | bigint
  /**
   * Optional free-text memo (max 256 chars per `Methods.ts`). MUST be
   * byte-equal to the corresponding `challenge.request.methodDetails.
   * splits[i].memo` when present on the challenge — `resolvePermit2Splits`
   * does a memo-aware deep-equal, so a memo-mismatch
   * (including undefined-vs-empty-string) rejects at construction. The
   * type is `readonly memo?: string` so callers can
   * actually satisfy that contract via explicit `opts.splits` (previously
   * the type omitted memo and the only working path was to omit
   * `opts.splits` entirely and let the SDK read from the challenge).
   */
  readonly memo?: string
}

export interface CreatePermit2CredentialOptions {
  /** The challenge from the server's 402 response. */
  readonly challenge: Challenge.Challenge
  /** Signer; address is recovered + checked against `did:pkh` source. */
  readonly account: LocalAccount
  /** EIP-155 chain id; must equal `methodDetails.chainId` in the challenge. */
  readonly chainId: number
  /** Permit2 contract address from `methodDetails.permit2Address`. */
  readonly permit2Address: `0x${string}`
  /** ERC-20 currency (== `challenge.request.currency`). */
  readonly currency: `0x${string}`
  /** Primary recipient (== `challenge.request.recipient`). */
  readonly recipient: `0x${string}`
  /** Total transfer amount (base units, == `challenge.request.amount`). */
  readonly amount: string | bigint
  /** Permit2 nonce (uint256 as decimal string OR bigint). */
  readonly nonce: string | bigint
  /** Permit2 deadline (unix seconds as decimal string OR bigint). */
  readonly deadline: string | bigint
  /**
   * Splits per draft §4.2.3. When present, MUST deep-equal
   * `challenge.request.methodDetails.splits` (length, per-entry recipient
   * case-insensitive, amount as bigint, memo). The challenge is the
   * canonical source of truth; this field is a backward-compatibility
   * affordance for callers that already pass splits explicitly. RECOMMENDED:
   * omit this field — the SDK reads splits directly from the challenge.
   *
   * When omitted (recommended) and the challenge HAS splits, generates a
   * batch permit (primary + N split entries) automatically. The primary's
   * amount becomes `amount - sum(splits[].amount)` (must be > 0 per draft
   * §4.2.3 strict-less-than check; verifier enforces).
   */
  readonly splits?: ReadonlyArray<Permit2Split>
  /**
   * Optional per-entry upper bound on `permitted[i].amount`. Defaults
   * to the exact transfer amount per entry (most secure — no slack for
   * fee-on-transfer tokens). Pass a larger value per entry if you need
   * to grant the spender extra headroom.
   */
  readonly permittedUpperBounds?: ReadonlyArray<string | bigint>
}

/**
 * Build + serialize a Permit2 credential. Auto-derives `source` from
 * `account.address` since draft §6.1 makes source REQUIRED here.
 */
export async function createPermit2Credential(
  opts: CreatePermit2CredentialOptions,
): Promise<string> {
  // Parse challenge, then assert 'permit2' is accepted. Spec
  // §4.2.2 / §6.3: an omitted methodDetails.credentialTypes defaults the
  // accepted set to ['transaction', 'hash'] only, so this is the path
  // where the most invisible client / server mismatches were happening
  // before the gate.
  const parsed = parseEvmChargeChallenge(opts.challenge)
  assertCredentialTypeAccepted(parsed, 'permit2')
  // Caller-passed wire fields must equal parsed wire truth.
  assertMatchesChallengeRequest(parsed, {
    chainId: opts.chainId,
    currency: opts.currency,
    recipient: opts.recipient,
    amount: opts.amount,
    permit2Address: opts.permit2Address,
  })
  // Splits SOURCE OF TRUTH is challenge.request.methodDetails.splits.
  // If opts.splits is passed, it MUST deep-equal the wire splits (length,
  // recipient case-insensitive, amount as bigint, memo). If opts.splits is
  // omitted, we use the wire splits directly. This eliminates the entire
  // class of bug where a caller's stale form state produced a credential
  // bound to splits the challenge didn't authorize.
  const resolvedSplits = resolvePermit2Splits(parsed, opts.splits)

  const challengeId = opts.challenge.id
  const realm = opts.challenge.realm
  const challengeHash = computeChallengeHash(challengeId, realm)

  const total = BigInt(opts.amount)
  const splits = resolvedSplits
  const isBatch = splits.length > 0
  const splitsSum = splits.reduce((sum, s) => sum + BigInt(s.amount), 0n)
  const primaryAmount = total - splitsSum

  // Build the entries in canonical order (primary first, then splits).
  const requestedAmounts: bigint[] = isBatch
    ? [primaryAmount, ...splits.map((s) => BigInt(s.amount))]
    : [total]
  const recipients: `0x${string}`[] = isBatch
    ? [opts.recipient, ...splits.map((s) => s.recipient)]
    : [opts.recipient]

  // permitted upper bounds: default = exact requested per entry.
  const permittedAmounts: bigint[] = (
    opts.permittedUpperBounds ?? requestedAmounts.map((a) => a.toString())
  ).map((b) => BigInt(b))
  if (permittedAmounts.length !== requestedAmounts.length) {
    throw new Error(
      `permittedUpperBounds.length (${permittedAmounts.length}) must equal entry count (${requestedAmounts.length})`,
    )
  }
  // Sanity: each permitted >= requested (Permit2 + server both enforce).
  for (let i = 0; i < requestedAmounts.length; i++) {
    if (permittedAmounts[i]! < requestedAmounts[i]!) {
      throw new Error(
        `permittedUpperBounds[${i}] (${permittedAmounts[i]}) must be >= requested (${requestedAmounts[i]})`,
      )
    }
  }

  // Spec §10.5 SHOULD: "clients SHOULD verify the contract address
  // matches the canonical deployment." Warn (not throw) so legitimate
  // fork/mirror deployments keep working while a tampered or
  // misconfigured challenge is at least visible.
  if (opts.permit2Address.toLowerCase() !== CANONICAL_PERMIT2_ADDRESS.toLowerCase()) {
    // eslint-disable-next-line no-console -- §10.5 client-side visibility
    console.warn(
      `createPermit2Credential: permit2Address ${opts.permit2Address} is not the canonical ` +
        `Permit2 deployment (${CANONICAL_PERMIT2_ADDRESS}) — verify this is an intentional ` +
        'fork/mirror deployment before approving tokens to it (spec §10.5)',
    )
  }

  const domain = permit2Domain(opts.chainId, opts.permit2Address)
  const nonce = BigInt(opts.nonce)
  const deadline = BigInt(opts.deadline)

  // Fail BEFORE the wallet signature prompt: an expired deadline is
  // guaranteed server rejection (verifier step 2).
  const nowSec = BigInt(Math.floor(Date.now() / 1000))
  if (deadline <= nowSec) {
    throw new Error(
      `createPermit2Credential: deadline ${deadline} is not in the future (now=${nowSec})`,
    )
  }

  // Permit2 `spender` field MUST equal the on-chain `msg.sender` at
  // settlement time, because Permit2's PermitHash._hashWithWitness
  // uses `msg.sender` (not a signed parameter) when reconstructing the
  // EIP-712 hash. The server-side settlement signer broadcasts
  // permitWitnessTransferFrom, so the user must sign with that address
  // as spender. The server publishes its settlement signer address in
  // the 402 challenge under `methodDetails.permit2Spender` —
  // require it here and use it.
  //
  // History: an earlier SDK iteration signed with `opts.permit2Address`
  // (the Permit2 contract address). That made local-side recovery
  // succeed (server's own recoverTypedDataAddress used the same wrong
  // spender, agreeing with the client) but failed on-chain settlement
  // with `InvalidSigner()` (0x815e1d64) because Permit2 used
  // msg.sender, not the Permit2 address. Fixed by reading the actual
  // settlement signer from the challenge.
  const md = parsed.methodDetails as { permit2Spender?: `0x${string}` }
  const spender = md.permit2Spender
  if (!spender) {
    throw new Error(
      'Permit2 credential requires challenge.request.methodDetails.permit2Spender — ' +
        'the server publishes its settlement signer address there so the user can sign with ' +
        'the correct EIP-712 spender. A challenge missing this field was issued by a server ' +
        'that pre-dates the spender-bug fix; upgrade the server-side SDK or the client cannot ' +
        'produce a credential Permit2 will accept (it would revert with InvalidSigner at ' +
        'settlement).',
    )
  }

  let signature: `0x${string}`
  if (isBatch) {
    signature = await opts.account.signTypedData({
      domain,
      types: permit2BatchTypes,
      primaryType: 'PermitBatchWitnessTransferFrom',
      message: {
        permitted: permittedAmounts.map((amount) => ({ token: opts.currency, amount })),
        spender,
        nonce,
        deadline,
        witness: { challengeHash },
      },
    })
  } else {
    signature = await opts.account.signTypedData({
      domain,
      types: permit2SingleTypes,
      primaryType: 'PermitWitnessTransferFrom',
      message: {
        permitted: { token: opts.currency, amount: permittedAmounts[0]! },
        spender,
        nonce,
        deadline,
        witness: { challengeHash },
      },
    })
  }

  // Build payload (string form for wire — verifier uses BigInt() to parse).
  const credential = Credential.from({
    challenge: opts.challenge,
    payload: {
      type: 'permit2',
      permit: {
        permitted: permittedAmounts.map((amount) => ({
          token: opts.currency,
          amount: amount.toString(),
        })),
        nonce: nonce.toString(),
        deadline: deadline.toString(),
      },
      transferDetails: requestedAmounts.map((requestedAmount, i) => ({
        to: recipients[i]!,
        requestedAmount: requestedAmount.toString(),
      })),
      witness: { challengeHash },
      signature,
    },
    // draft §6.1 REQUIRED: source MUST match recovered signer.
    source: `did:pkh:eip155:${opts.chainId}:${opts.account.address}`,
  })
  return Credential.serialize(credential)
}
