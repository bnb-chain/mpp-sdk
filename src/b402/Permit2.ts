/**
 * b402 Permit2 (`permit2-exact`) — browser-safe buyer signer + validator.
 *
 * Source of truth: the b402 "Permit2 Signing Guide"
 * (developers.binance.com → onchainpay-x402 → Open APIs V2 → Permit2 Signing,
 * captured 2026-07-02). Key wire facts, verbatim from that guide:
 *
 *   - EIP-712 domain is `{ name: 'Permit2', chainId, verifyingContract }` —
 *     NO version field (adding one changes the separator → sig rejected).
 *   - Witness struct is exactly `Witness { address to; uint256 validAfter }` —
 *     struct NAME and FIELD ORDER are load-bearing for the typehash.
 *   - `spender` is the Permit2 PROXY contract (`extra.spenderAddress`), not
 *     the facilitator EOA (`extra.signerAddress`).
 *   - Numeric fields sign as uint256 but travel as DECIMAL STRINGS.
 *   - The SDK product boundary is exact-only; upto payload and settlement
 *     semantics are deliberately not modeled (ADR-0004).
 *
 * SECURITY MODEL (ADR-0004): a buyer cannot call `/supported` (it is
 * RSA-credentialed, merchant-only), so every spender/witness value in a 402 is
 * attacker-controllable from the buyer's seat — and a Permit2 signature to a
 * hostile spender is a direct token-theft instrument. Therefore:
 *
 *   - `trustedSpenders` is REQUIRED (no default-trust). Pass the matching
 *     `CURATED_B402_SPENDERS[network].exact` entry explicitly, or your own
 *     audited Permit2 Exact proxy list.
 *   - The witness is constructed HERE from `requirements.payTo` — a
 *     server-supplied witness blob is never signed verbatim.
 *   - `permitted.amount` is pinned to `requirements.amount` (exact, 1:1).
 *   - The deadline is capped (a long-dated permit is an off-protocol spend
 *     authorization).
 *
 * This is the B402 provider proof, carried inside `b402/charge`; it is NOT the
 * standard mppx `evm/charge` Permit2 credential. The two Methods sign different
 * spenders and witness structs, so one signature cannot serve both.
 */

import { type Hex, type LocalAccount, recoverTypedDataAddress } from 'viem'

import { chainIdFromNetwork, randomB402Nonce } from './Payload.js'
import {
  X402_VERSION,
  type PaymentRequirements,
  type Permit2Authorization,
  type Permit2PaymentPayload,
} from './Types.js'

/** Canonical Permit2 — same address on every EVM chain (b402 signs against it). */
export const B402_PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const

/**
 * b402 Permit2 proxy spenders observed live on `/supported` (2026-07-02).
 * DATED reference data, not an implicit trust root: b402 may redeploy proxies
 * (their docs say to re-read `/supported`), so callers pass this — or their
 * own fresher list — EXPLICITLY as `trustedSpenders`. Merchants can read the
 * current value from `/supported`; buyers cannot (RSA-gated), which is exactly
 * why the allowlist is a required parameter.
 */
export const CURATED_B402_SPENDERS: Readonly<Record<string, { readonly exact: `0x${string}` }>> = {
  'eip155:56': {
    exact: '0x3038f7ac3b4D1a3fe886BdCB5cD01e9f6BDd8633',
  },
  'eip155:97': {
    exact: '0x45481A7FaFc1e62Bb7D851645927E32a2FFA0271',
  },
}

/** The b402 permit2-exact EIP-712 types — verbatim from the signing guide. */
export const b402Permit2Types = {
  PermitWitnessTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'witness', type: 'Witness' },
  ],
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  Witness: [
    { name: 'to', type: 'address' },
    { name: 'validAfter', type: 'uint256' },
  ],
} as const

/** Permit2's three-field domain — deliberately NO `version`. */
export function b402Permit2Domain(chainId: number): {
  readonly name: 'Permit2'
  readonly chainId: number
  readonly verifyingContract: `0x${string}`
} {
  return { name: 'Permit2', chainId, verifyingContract: B402_PERMIT2_ADDRESS }
}

/** Hard cap slack added on top of the larger of maxTimeoutSeconds / 1h. */
const DEADLINE_SLACK_SEC = 600n

export interface BuildPermit2ExactPaymentOptions {
  /** The signer — its address becomes `permit2Authorization.from` (the payer). */
  readonly account: LocalAccount
  /** The chosen `accepts[]` entry (must be scheme `exact` / method `permit2-exact`). */
  readonly requirements: PaymentRequirements
  /**
   * REQUIRED spender allowlist — `requirements.extra.spenderAddress` must be in
   * it or the build refuses. Pass `[CURATED_B402_SPENDERS[network].exact]` or
   * your own audited Permit2 Exact proxy list; there is intentionally no
   * default. Do not include the `upto` proxy in an Exact allowlist.
   */
  readonly trustedSpenders: readonly string[]
  /** Optional ResourceInfo `url` for traceability. */
  readonly resourceUrl?: string
  /** Unix seconds; default `now - 60` (clock-skew backdate). Must not be in the future. */
  readonly validAfter?: string | bigint
  /** Unix seconds; default `now + 3600`. Capped — see module JSDoc. */
  readonly deadline?: string | bigint
  /**
   * Optional caller-supplied unordered nonce. Native B402/x402 callers
   * normally leave this unset for a random nonce; the MPP `b402/charge`
   * client supplies the Challenge hash so the permit cannot be replayed under
   * another server-issued Challenge with otherwise identical economics.
   */
  readonly nonce?: string | bigint
}

/**
 * Sign a b402 `permit2-exact` payment: EIP-712 `PermitWitnessTransferFrom`
 * against the canonical Permit2 domain, witness bound to the merchant's
 * `payTo`. Returns the x402 v2 `PaymentPayload`; encode with `encodeXPayment`.
 *
 * Prerequisite (buyer-side, once per wallet+token): `approve(Permit2, max)` on
 * the token — `/verify` does not check it, but `/settle` reverts without it.
 */
export async function buildPermit2ExactPayment(
  options: BuildPermit2ExactPaymentOptions,
): Promise<Permit2PaymentPayload> {
  const { account, requirements, trustedSpenders } = options
  if (requirements.scheme !== 'exact') {
    throw new Error(
      `buildPermit2ExactPayment: requirements use scheme '${requirements.scheme}', only 'exact' is supported`,
    )
  }
  if (requirements.extra.assetTransferMethod !== 'permit2-exact') {
    throw new Error(
      `buildPermit2ExactPayment: requirements use '${requirements.extra.assetTransferMethod}', not 'permit2-exact' ` +
        `(only the B402 Exact product surface is supported — see ADR-0004)`,
    )
  }
  const spender = requirements.extra.spenderAddress
  if (!spender) {
    throw new Error('buildPermit2ExactPayment: requirements.extra.spenderAddress is missing')
  }
  // Spender allowlist — the anti-phishing anchor. A 402 is attacker-supplied
  // input from the buyer's seat; never sign a permit to an unvetted spender.
  if (!Array.isArray(trustedSpenders) || trustedSpenders.length === 0) {
    throw new Error(
      'buildPermit2ExactPayment: trustedSpenders is required and must be non-empty — pass ' +
        '[CURATED_B402_SPENDERS[network].exact] or your own audited Permit2 Exact spender list',
    )
  }
  const spenderLower = spender.toLowerCase()
  if (!trustedSpenders.some((s) => s.toLowerCase() === spenderLower)) {
    throw new Error(
      `buildPermit2ExactPayment: spenderAddress ${spender} is not in trustedSpenders — ` +
        `refusing to sign a Permit2 authorization to an unvetted spender`,
    )
  }

  const chainId = chainIdFromNetwork(requirements.network)
  const nowSec = BigInt(Math.floor(Date.now() / 1000))
  const validAfter = options.validAfter !== undefined ? BigInt(options.validAfter) : nowSec - 60n
  if (validAfter > nowSec) {
    throw new Error(
      `buildPermit2ExactPayment: validAfter ${validAfter} is in the future — the proxy would revert at settle`,
    )
  }
  const deadline = options.deadline !== undefined ? BigInt(options.deadline) : nowSec + 3600n
  const timeout = BigInt(Math.max(requirements.maxTimeoutSeconds, 3600))
  const deadlineCap = nowSec + timeout + DEADLINE_SLACK_SEC
  if (deadline <= nowSec) {
    throw new Error(`buildPermit2ExactPayment: deadline ${deadline} is not in the future`)
  }
  if (deadline > deadlineCap) {
    throw new Error(
      `buildPermit2ExactPayment: deadline ${deadline} exceeds the cap ${deadlineCap} — a ` +
        `long-dated permit is an off-protocol spend authorization; shorten it`,
    )
  }

  const nonce = options.nonce !== undefined ? BigInt(options.nonce) : BigInt(randomB402Nonce())
  if (nonce < 0n || nonce >= 1n << 256n) {
    throw new Error('buildPermit2ExactPayment: nonce must fit uint256')
  }

  const signature = await account.signTypedData({
    domain: b402Permit2Domain(chainId),
    types: b402Permit2Types,
    primaryType: 'PermitWitnessTransferFrom',
    message: {
      permitted: { token: requirements.asset, amount: BigInt(requirements.amount) },
      spender: spender as `0x${string}`,
      nonce,
      deadline,
      // Witness constructed HERE, never copied from server-supplied blobs:
      // it binds the signature to the merchant recipient in the requirements.
      witness: { to: requirements.payTo, validAfter },
    },
  })

  const permit2Authorization: Permit2Authorization = {
    permitted: { token: requirements.asset, amount: requirements.amount },
    from: account.address,
    spender: spender as `0x${string}`,
    nonce: nonce.toString(),
    deadline: deadline.toString(),
    witness: { to: requirements.payTo, validAfter: validAfter.toString() },
  }

  return {
    x402Version: X402_VERSION,
    ...(options.resourceUrl
      ? { resource: { url: options.resourceUrl, mimeType: 'application/json' } }
      : {}),
    accepted: requirements,
    payload: { signature, permit2Authorization },
  }
}

/**
 * Recover the payer address from a signed permit2-exact `PaymentPayload` — the
 * EIP-712 `PermitWitnessTransferFrom` signer. Compare against
 * `payload.payload.permit2Authorization.from` before trusting it.
 */
export function recoverPermit2ExactPayer(payload: Permit2PaymentPayload): Promise<`0x${string}`> {
  const auth = payload.payload.permit2Authorization
  return recoverTypedDataAddress({
    domain: b402Permit2Domain(chainIdFromNetwork(payload.accepted.network)),
    types: b402Permit2Types,
    primaryType: 'PermitWitnessTransferFrom',
    message: {
      permitted: { token: auth.permitted.token, amount: BigInt(auth.permitted.amount) },
      spender: auth.spender,
      nonce: BigInt(auth.nonce),
      deadline: BigInt(auth.deadline),
      witness: { to: auth.witness.to, validAfter: BigInt(auth.witness.validAfter) },
    },
    signature: payload.payload.signature as Hex,
  })
}

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/
/** Permit2 signatures are strictly 65-byte r||s||v per the signing guide. */
const HEX_SIGNATURE_65 = /^0x[0-9a-fA-F]{130}$/
const DECIMAL = /^\d+$/
const CAIP2_EIP155 = /^eip155:\d+$/

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}
function isMatch(v: unknown, re: RegExp): boolean {
  return typeof v === 'string' && re.test(v)
}
function sameAddress(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
}

/**
 * Narrow an untrusted decoded value to a well-formed `exact` / `permit2-exact`
 * / x402-v2 `PaymentPayload`. Same rigor as `isEip3009PaymentPayload`, PLUS the
 * permit2 cross-field equalities b402's own verifier enforces (spender ==
 * extra.spenderAddress, witness.to == payTo, permitted == asset/amount) — a
 * payload failing them can never settle, so gate it out before any network
 * call. Shape/format only beyond that: signature validity and allowance are
 * `/verify` · `/settle`'s job.
 */
export function isPermit2PaymentPayload(value: unknown): value is Permit2PaymentPayload {
  if (!isRecord(value)) return false
  if (value['x402Version'] !== X402_VERSION) return false

  const accepted = value['accepted']
  if (!isRecord(accepted)) return false
  if (accepted['scheme'] !== 'exact') return false
  if (!isMatch(accepted['network'], CAIP2_EIP155)) return false
  if (!isMatch(accepted['amount'], DECIMAL)) return false
  if (!isMatch(accepted['asset'], HEX_ADDRESS)) return false
  if (!isMatch(accepted['payTo'], HEX_ADDRESS)) return false
  const timeout = accepted['maxTimeoutSeconds']
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) return false
  const extra = accepted['extra']
  if (!isRecord(extra)) return false
  if (extra['assetTransferMethod'] !== 'permit2-exact') return false
  if (typeof extra['name'] !== 'string' || typeof extra['version'] !== 'string') return false
  if (!isMatch(extra['signerAddress'], HEX_ADDRESS)) return false
  if (!isMatch(extra['spenderAddress'], HEX_ADDRESS)) return false

  const payload = value['payload']
  if (!isRecord(payload)) return false
  if (!isMatch(payload['signature'], HEX_SIGNATURE_65)) return false
  const auth = payload['permit2Authorization']
  if (!isRecord(auth)) return false
  const permitted = auth['permitted']
  if (!isRecord(permitted)) return false
  if (!isMatch(permitted['token'], HEX_ADDRESS)) return false
  if (!isMatch(permitted['amount'], DECIMAL)) return false
  if (!isMatch(auth['from'], HEX_ADDRESS)) return false
  if (!isMatch(auth['spender'], HEX_ADDRESS)) return false
  if (!isMatch(auth['nonce'], DECIMAL)) return false
  if (!isMatch(auth['deadline'], DECIMAL)) return false
  const witness = auth['witness']
  if (!isRecord(witness)) return false
  if (!isMatch(witness['to'], HEX_ADDRESS)) return false
  if (!isMatch(witness['validAfter'], DECIMAL)) return false

  // Cross-field equalities — violating any of these is a guaranteed b402
  // rejection (recipient/value mismatch), so fail closed here.
  if (!sameAddress(auth['spender'], extra['spenderAddress'])) return false
  if (!sameAddress(witness['to'], accepted['payTo'])) return false
  if (!sameAddress(permitted['token'], accepted['asset'])) return false
  if (permitted['amount'] !== accepted['amount']) return false

  return true
}
