/**
 * Credential build — dispatches the selected route to the existing
 * `@bnb-chain/mpp/client` low-level constructors, handling the one-time Permit2
 * approve and the per-method on-chain reads (nonce / fees / broadcast).
 *
 * Ordering contract: every method's CHEAP, no-I/O challenge validation runs
 * FIRST (`assertBuildableChallenge`), before any state change — so a challenge
 * that the constructor would reject (missing `permit2Spender`, splits on a
 * non-permit2 route, ...) never costs the buyer a `approve` / `transfer`. Once a
 * transfer/approve IS broadcast, any later failure throws `PaymentSideEffectError`
 * carrying the tx hash so the caller can reconcile rather than re-`pay()`.
 */

import type { Challenge } from 'mppx'
import {
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type WalletClient,
  erc20Abi,
  maxUint256,
} from 'viem'

import type { CredentialType } from '../../Methods.js'
import { createAuthorizationCredential } from '../Authorization.js'
import { createHashCredential } from '../Hash.js'
import {
  assertCredentialTypeAccepted,
  assertNoSplitsForNonPermit2,
  parseEvmChargeChallenge,
} from '../internal/AssertChallenge.js'
import { createPermit2Credential } from '../Permit2.js'
import { createTransactionCredential } from '../Transaction.js'
import { PaymentSideEffectError } from './request.js'
import type { LogicalPath } from './routes.js'

export interface BuildContext {
  challenge: Challenge.Challenge
  account: LocalAccount
  publicClient: PublicClient
  walletClient: WalletClient
  chainId: number
  currency: Address
  recipient: Address
  amount: string
  permit2Address: Address
  eip712?: { name: string; version: string }
  /**
   * Whether a one-time Permit2 `approve` may be sent. Re-checked HERE (not only
   * at selection) because the allowance can change between select and build; a
   * `false` with an insufficient allowance FAILS CLOSED rather than approving.
   */
  allowApproval: boolean
  /** The selected route — carried so post-side-effect errors can reference it. */
  route: LogicalPath
}

/**
 * No-I/O challenge validation for a method — mirrors the guards the low-level
 * constructor runs, hoisted so it happens BEFORE any `approve`/`transfer`.
 */
function assertBuildableChallenge(method: CredentialType, challenge: Challenge.Challenge): void {
  const parsed = parseEvmChargeChallenge(challenge)
  assertCredentialTypeAccepted(parsed, method)
  if (method === 'permit2') {
    // The server publishes its settlement signer as `permit2Spender`; without
    // it a Permit2 credential reverts `InvalidSigner` at settlement. Fail BEFORE
    // spending gas on a max approve the credential can never redeem.
    if (!(parsed.methodDetails as { permit2Spender?: string }).permit2Spender) {
      throw new Error(
        'permit2 selected but challenge.request.methodDetails.permit2Spender is missing — ' +
          'refusing to send a Permit2 approve for a credential the server cannot accept ' +
          '(it would revert with InvalidSigner at settlement). Upgrade the server SDK, or ' +
          'restrict the policy so a different route is chosen.',
      )
    }
  } else {
    assertNoSplitsForNonPermit2(parsed, method)
  }
}

/**
 * Wait for a broadcast tx's receipt and REQUIRE `status === 'success'`. A
 * timeout / RPC error or an on-chain revert both throw `PaymentSideEffectError`
 * with the tx hash — the transfer/approve already happened, so the caller must
 * reconcile it, not silently proceed to sign/retry.
 */
async function confirmSettlementTx(
  publicClient: PublicClient,
  hash: Hex,
  route: LogicalPath,
  kind: 'approve' | 'transfer',
): Promise<void> {
  const idField = kind === 'approve' ? { approveTxHash: hash } : { txHash: hash }
  let status: 'success' | 'reverted'
  try {
    ;({ status } = await publicClient.waitForTransactionReceipt({ hash }))
  } catch (cause) {
    throw new PaymentSideEffectError(
      `${route.id}: ${kind} tx ${hash} was broadcast but its receipt could not be confirmed ` +
        `— reconcile on-chain before retrying`,
      route,
      { ...idField, cause },
    )
  }
  if (status !== 'success') {
    throw new PaymentSideEffectError(
      `${route.id}: ${kind} tx ${hash} reverted on-chain (status=${status})`,
      route,
      idField,
    )
  }
}

export async function buildCredential(method: CredentialType, c: BuildContext): Promise<string> {
  // #1 — cheap validation up front, before ANY branch does I/O or a state change.
  assertBuildableChallenge(method, c.challenge)

  switch (method) {
    case 'authorization': {
      if (!c.eip712) throw new Error('authorization selected but no EIP-712 domain resolved')
      return createAuthorizationCredential({
        challenge: c.challenge,
        account: c.account,
        chainId: c.chainId,
        currency: c.currency,
        recipient: c.recipient,
        amount: c.amount,
        eip712: c.eip712,
      })
    }
    case 'permit2': {
      const allowance = await c.publicClient.readContract({
        address: c.currency,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [c.account.address, c.permit2Address],
      })
      let approveTxHash: Hex | undefined
      if (allowance < BigInt(c.amount)) {
        // Honor the policy even if the allowance dropped since route selection.
        if (!c.allowApproval) {
          throw new Error(
            `permit2 selected but the Permit2 allowance (${allowance}) is below the amount ` +
              `(${c.amount}) and policy.allowApproval is false — refusing to send an approve ` +
              `(the allowance may have changed since route selection).`,
          )
        }
        const approveTx = await c.walletClient.writeContract({
          account: c.account,
          chain: c.walletClient.chain ?? null,
          address: c.currency,
          abi: erc20Abi,
          functionName: 'approve',
          args: [c.permit2Address, maxUint256],
        })
        await confirmSettlementTx(c.publicClient, approveTx, c.route, 'approve')
        approveTxHash = approveTx
      }
      try {
        return await createPermit2Credential({
          challenge: c.challenge,
          account: c.account,
          chainId: c.chainId,
          permit2Address: c.permit2Address,
          currency: c.currency,
          recipient: c.recipient,
          amount: c.amount,
          nonce: randomNonce(),
          deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
        })
      } catch (cause) {
        // A signature rejection / RPC error here throws AFTER the max approve was
        // broadcast (when one fired). Surface the approveTxHash so the caller can
        // reconcile the on-chain allowance grant — matching the hash route below.
        // No approve this run → nothing irreversible happened; surface as-is.
        if (approveTxHash !== undefined) {
          throw new PaymentSideEffectError(
            `${c.route.id}: Permit2 approve ${approveTxHash} was broadcast but the credential ` +
              `could not be built — reconcile the on-chain allowance before retrying`,
            c.route,
            { approveTxHash, cause },
          )
        }
        throw cause
      }
    }
    case 'transaction': {
      const [nonce, fees] = await Promise.all([
        c.publicClient.getTransactionCount({ address: c.account.address, blockTag: 'pending' }),
        c.publicClient.estimateFeesPerGas().catch(async () => {
          const gasPrice = await c.publicClient.getGasPrice()
          return { maxFeePerGas: gasPrice, maxPriorityFeePerGas: gasPrice }
        }),
      ])
      return createTransactionCredential({
        challenge: c.challenge,
        account: c.account,
        chainId: c.chainId,
        currency: c.currency,
        recipient: c.recipient,
        amount: c.amount,
        nonce,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      })
    }
    case 'hash': {
      const txHash = await c.walletClient.writeContract({
        account: c.account,
        chain: c.walletClient.chain ?? null,
        address: c.currency,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [c.recipient, BigInt(c.amount)],
      })
      // The transfer IS the payment — from here on every failure carries txHash.
      await confirmSettlementTx(c.publicClient, txHash, c.route, 'transfer')
      try {
        return await createHashCredential({ challenge: c.challenge, hash: txHash })
      } catch (cause) {
        throw new PaymentSideEffectError(
          `${c.route.id}: transfer ${txHash} settled but the hash credential could not be ` +
            `finalized — reference this tx to reconcile`,
          c.route,
          { txHash, cause },
        )
      }
    }
  }
}

function randomNonce(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let hex: Hex = '0x'
  for (const b of bytes) hex = `${hex}${b.toString(16).padStart(2, '0')}` as Hex
  return BigInt(hex)
}
