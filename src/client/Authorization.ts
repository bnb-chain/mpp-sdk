/**
 * EIP-3009 authorization credential constructor (client side, spec §6.2).
 *
 * Signs an EIP-712 `TransferWithAuthorization` typed-data structure
 * against the curated ERC-20 token domain (Circle USDC and similar
 * EIP-3009-supporting tokens), wraps the signature into an authorization
 * credential, and returns the serialized credential string that is the
 * COMPLETE `Authorization` header value (already includes the `Payment `
 * scheme prefix — pass as `headers: { Authorization: credential }`).
 *
 * The server (`verifyAuthorization`, §8.2) does typed-data recovery and
 * settles via `transferWithAuthorization(from, to, value, validAfter,
 * validBefore, nonce, v, r, s)` on the token contract.
 *
 * `nonce` is auto-derived from `keccak256(packed(challenge.id, realm))`
 * (spec §5.3, `eip3009Nonce`) — clients MUST NOT supply their own nonce
 * because the verifier re-computes it from the challenge and rejects on
 * mismatch.
 *
 * `validAfter` / `validBefore` default to `now-60s` / `now+10min` which
 * gives a comfortable ~10 minute window; pass explicit values for tighter
 * windows or for advance-scheduled transfers.
 *
 * EIP-712 domain (`tokenName` + `tokenVersion`) must come from the
 * SDK's curated token matrix — `getCuratedEip712Domain(chain, token)` on
 * the server side resolves it; on the client the caller passes it
 * directly (the SDK does not probe arbitrary tokens for EIP-3009 support).
 */

import { type Challenge, Credential } from 'mppx'
import { type LocalAccount } from 'viem'

import { eip3009Domain, eip3009Nonce, eip3009Types } from '../protocol/TypedData.js'
import {
  assertCredentialTypeAccepted,
  assertMatchesChallengeRequest,
  assertNoSplitsForNonPermit2,
  parseEvmChargeChallenge,
} from './internal/AssertChallenge.js'

export interface CreateAuthorizationCredentialOptions {
  /** The challenge from the server's 402 response. */
  readonly challenge: Challenge.Challenge
  /** Signer; address becomes `payload.from` and the on-chain debit address. */
  readonly account: LocalAccount
  /** EIP-155 chain id (== `methodDetails.chainId`). */
  readonly chainId: number
  /** ERC-20 currency / token contract (== `challenge.request.currency`). */
  readonly currency: `0x${string}`
  /** Transfer recipient (== `challenge.request.recipient`). */
  readonly recipient: `0x${string}`
  /** Transfer amount in base units (== `challenge.request.amount`). */
  readonly amount: string | bigint
  /**
   * Curated EIP-712 token domain — `tokenName` + `tokenVersion`. On the
   * server side this comes from `src/server/curated.ts`
   * `getCuratedEip712Domain(chain, token)`; on the client the caller
   * supplies it directly (the SDK does not probe arbitrary tokens for
   * EIP-3009 support).
   */
  readonly eip712: { readonly name: string; readonly version: string }
  /**
   * EIP-3009 `validAfter`, unix seconds. Default `now - 60`.
   */
  readonly validAfter?: string | bigint
  /**
   * EIP-3009 `validBefore`, unix seconds. Default `now + 600` (10 min
   * window). Tighten to reduce replay risk if you have a known
   * settlement-latency budget.
   */
  readonly validBefore?: string | bigint
  /**
   * Optional `did:pkh:eip155:<chainId>:<account.address>`. The verifier
   * already requires `recovered signer === payload.from`, so this is
   * effectively a no-op redundancy check unless the deployment uses it
   * for audit / logging.
   */
  readonly source?: string
}

export async function createAuthorizationCredential(
  opts: CreateAuthorizationCredentialOptions,
): Promise<string> {
  // Parse challenge, then assert this credential type is in the
  // server-advertised accepted set. Default: when methodDetails.
  // credentialTypes is omitted the accepted set is ['transaction','hash']
  // ONLY — so an omitted-credentialTypes challenge rejects 'authorization'
  // before any signing happens.
  const parsed = parseEvmChargeChallenge(opts.challenge)
  assertCredentialTypeAccepted(parsed, 'authorization')
  // Authorization cannot fulfill splits (single-transfer EIP-3009).
  assertNoSplitsForNonPermit2(parsed, 'authorization')
  // Caller-passed wire fields must equal parsed wire truth.
  assertMatchesChallengeRequest(parsed, {
    chainId: opts.chainId,
    currency: opts.currency,
    recipient: opts.recipient,
    amount: opts.amount,
  })

  const challengeId = opts.challenge.id
  const realm = opts.challenge.realm
  const nonce = eip3009Nonce(challengeId, realm)

  const nowSec = BigInt(Math.floor(Date.now() / 1000))
  const validAfter = opts.validAfter !== undefined ? BigInt(opts.validAfter) : nowSec - 60n
  const validBefore = opts.validBefore !== undefined ? BigInt(opts.validBefore) : nowSec + 600n

  const value = BigInt(opts.amount)
  const from = opts.account.address
  const to = opts.recipient

  const domain = eip3009Domain({
    tokenName: opts.eip712.name,
    tokenVersion: opts.eip712.version,
    chainId: opts.chainId,
    tokenAddress: opts.currency,
  })

  const signature = await opts.account.signTypedData({
    domain,
    types: eip3009Types,
    primaryType: 'TransferWithAuthorization',
    message: {
      from,
      to,
      value,
      validAfter,
      validBefore,
      nonce,
    },
  })

  const credential = Credential.from({
    challenge: opts.challenge,
    payload: {
      type: 'authorization',
      from,
      to,
      value: value.toString(),
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce,
      signature,
    },
    ...(opts.source !== undefined && { source: opts.source }),
  })
  return Credential.serialize(credential)
}
