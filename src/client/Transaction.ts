/**
 * Transaction credential constructor (client side, spec §6.3).
 *
 * Signs a full EIP-1559 `transfer(recipient, amount)` calldata against the
 * curated ERC-20 contract, wraps the resulting signed RLP into a
 * transaction credential, and returns the serialized credential string
 * that is the COMPLETE `Authorization` header value (already includes
 * the `Payment ` scheme prefix — pass as `headers: { Authorization:
 * credential }`).
 *
 * The server (`verifyTransaction`, §8.3) does:
 *   1. Local re-parse + strict field match against the challenge.
 *   2. Broadcast via `sendRawTransaction` (with already-known / nonce-too-low
 *      retry logic against the actual on-chain receipt).
 *   3. Settlement assertion via Transfer log match + `markConsumed`.
 *
 * Client responsibilities here:
 *   - chainId / nonce / gas / fee fields must be passed by the caller —
 *     this function does NOT probe RPC (clients vary in their nonce /
 *     fee resolution strategy: e.g. wallet abstractions, paymaster, etc.).
 *   - The signing account becomes both the `Transfer.from` on-chain
 *     emitter AND the basis for an optional `did:pkh` `source` field.
 */

import { type Challenge, Credential } from 'mppx'
import { type LocalAccount, encodeFunctionData } from 'viem'

import {
  assertCredentialTypeAccepted,
  assertMatchesChallengeRequest,
  assertNoSplitsForNonPermit2,
  parseEvmChargeChallenge,
} from './internal/AssertChallenge.js'

const ERC20_TRANSFER_ABI = [
  {
    type: 'function',
    name: 'transfer',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
    stateMutability: 'nonpayable',
  },
] as const

export interface CreateTransactionCredentialOptions {
  /** The challenge from the server's 402 response. */
  readonly challenge: Challenge.Challenge
  /** The signer. Its address becomes the on-chain `Transfer.from`. */
  readonly account: LocalAccount
  /** EIP-155 chain id; must equal `methodDetails.chainId` in the challenge. */
  readonly chainId: number
  /** ERC-20 contract address (== challenge.request.currency). */
  readonly currency: `0x${string}`
  /** ERC-20 transfer recipient (== challenge.request.recipient). */
  readonly recipient: `0x${string}`
  /** Transfer amount in base units (== challenge.request.amount). */
  readonly amount: string | bigint
  /** Account nonce for the signed tx. */
  readonly nonce: number
  /** EIP-1559 max fee per gas. */
  readonly maxFeePerGas: bigint
  /** EIP-1559 max priority fee per gas. */
  readonly maxPriorityFeePerGas: bigint
  /** Gas limit. Default 100_000 — covers most ERC-20 transfer() calls. */
  readonly gas?: bigint
  /**
   * Optional `did:pkh:eip155:<chainId>:<account.address>`. Currently the
   * transaction verifier only consults this when set (spec §8.3 step 8);
   * if you pass it, it MUST match `account.address`.
   */
  readonly source?: string
}

export async function createTransactionCredential(
  opts: CreateTransactionCredentialOptions,
): Promise<string> {
  // Parse + accepted-types check. 'transaction' is in the
  // client-default accepted set per spec §6.3, so an omitted-credentialTypes
  // challenge will accept it; only an explicit allowlist that excludes
  // 'transaction' will reject here.
  const parsed = parseEvmChargeChallenge(opts.challenge)
  assertCredentialTypeAccepted(parsed, 'transaction')
  // Transaction is a single ERC-20 transfer; splits would require
  // multiple transactions and break atomicity. Reject.
  assertNoSplitsForNonPermit2(parsed, 'transaction')
  // Caller-passed wire fields must equal parsed wire truth.
  assertMatchesChallengeRequest(parsed, {
    chainId: opts.chainId,
    currency: opts.currency,
    recipient: opts.recipient,
    amount: opts.amount,
  })

  const data = encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: 'transfer',
    args: [opts.recipient, BigInt(opts.amount)],
  })
  const signature = await opts.account.signTransaction({
    chainId: opts.chainId,
    to: opts.currency,
    value: 0n,
    data,
    nonce: opts.nonce,
    type: 'eip1559',
    gas: opts.gas ?? 100_000n,
    maxFeePerGas: opts.maxFeePerGas,
    maxPriorityFeePerGas: opts.maxPriorityFeePerGas,
  })

  const credential = Credential.from({
    challenge: opts.challenge,
    payload: { type: 'transaction', signature },
    ...(opts.source !== undefined && { source: opts.source }),
  })
  return Credential.serialize(credential)
}
