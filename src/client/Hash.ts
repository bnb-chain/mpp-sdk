/**
 * Hash credential constructor (client side, spec §6.4).
 *
 * The hash credential is the simplest of the four — no signing required.
 * The payer broadcasts a previously-made on-chain transfer (or finds an
 * existing one) and presents only its `txHash`. The server (`verifyHash`,
 * §8.4) then correlates the receipt and Transfer event against the
 * challenge.
 *
 * Use this when:
 *   - The payer already made the transfer outside the request flow
 *     (e.g. via a wallet UI separately).
 *   - The payer / server topology has a chargeFromDecimal-style flow
 *     where users sweep external balances into the merchant address.
 *
 * Servers default to `hashFromPolicy: 'strict_from'` (audit H01) and
 * reject a hash credential whose `source` is missing or does not match
 * the on-chain Transfer.from — ALWAYS pass `source` (DID PKH form of the
 * tx sender) unless you know the server opted back to `'lax_from'`.
 * The high-level `pay()` flow fills it in automatically.
 */

import { type Challenge, Credential } from 'mppx'

import {
  assertCredentialTypeAccepted,
  assertNoSplitsForNonPermit2,
  parseEvmChargeChallenge,
} from './internal/AssertChallenge.js'

/** Local bytes32 regex — same shape `chargeMethod.schema.credential.payload`
 *  enforces for hash. Inlined here so the validator is self-contained and
 *  doesn't need to round-trip the whole payload through schema.parse. */
const BYTES32_HEX = /^0x[0-9a-fA-F]{64}$/

export interface CreateHashCredentialOptions {
  /**
   * The challenge issued by the server's 402 response. Typically obtained
   * via `Challenge.fromHeaders(response.headers)` or
   * `Challenge.deserialize(authHeader)` on the client.
   */
  readonly challenge: Challenge.Challenge
  /** The 32-byte transaction hash of the on-chain settlement. */
  readonly hash: `0x${string}`
  /**
   * `did:pkh:eip155:<chainId>:<address>` identifier of the tx-from
   * address. REQUIRED under the server DEFAULT `hashFromPolicy:
   * 'strict_from'` (spec §8.4 step 6, audit H01) — it must match the
   * on-chain Transfer.from or the credential is rejected. Only servers
   * explicitly opted back to `'lax_from'` ignore this field.
   */
  readonly source?: string
}

/**
 * Build + serialize a hash credential. The returned string is the
 * COMPLETE `Authorization` header value (mppx's `Credential.serialize`
 * already prepends the `Payment ` scheme prefix). Use as-is:
 *
 *   fetch(url, { headers: { Authorization: credential } })
 */
export async function createHashCredential(opts: CreateHashCredentialOptions): Promise<string> {
  // Validate that this challenge is an EVM Charge challenge AND
  // that the server actually accepts 'hash' credentials. Previously this
  // constructor was the only one that completely bypassed any validation;
  // a caller could happily build a Hash credential against a Permit2-only
  // challenge and only find out at server verify time.
  const parsed = parseEvmChargeChallenge(opts.challenge)
  assertCredentialTypeAccepted(parsed, 'hash')
  // Hash credentials cannot fulfill splits; reject early.
  assertNoSplitsForNonPermit2(parsed, 'hash')
  // Validate hash shape locally (bytes32 hex). The wire schema
  // would catch this server-side, but failing here gives a clearer error
  // and skips the round-trip through Credential.from + serialize.
  if (typeof opts.hash !== 'string' || !BYTES32_HEX.test(opts.hash)) {
    throw new Error(
      `createHashCredential: 'hash' must be a 0x-prefixed 32-byte hex string ` +
        `(got ${JSON.stringify(opts.hash)}). hash is the on-chain settlement tx hash.`,
    )
  }

  const credential = Credential.from({
    challenge: opts.challenge,
    payload: { type: 'hash', hash: opts.hash },
    ...(opts.source !== undefined && { source: opts.source }),
  })
  return Credential.serialize(credential)
}
