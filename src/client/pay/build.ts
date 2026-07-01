/**
 * Credential build — dispatches the selected route to the existing
 * `@bnb-chain/mpp/client` low-level constructors, handling the one-time Permit2
 * approve and the per-method on-chain reads (nonce / fees / broadcast).
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
import { createPermit2Credential } from '../Permit2.js'
import { createTransactionCredential } from '../Transaction.js'

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
}

export async function buildCredential(method: CredentialType, c: BuildContext): Promise<string> {
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
      if (allowance < BigInt(c.amount)) {
        const approveTx = await c.walletClient.writeContract({
          account: c.account,
          chain: c.walletClient.chain ?? null,
          address: c.currency,
          abi: erc20Abi,
          functionName: 'approve',
          args: [c.permit2Address, maxUint256],
        })
        await c.publicClient.waitForTransactionReceipt({ hash: approveTx })
      }
      return createPermit2Credential({
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
      await c.publicClient.waitForTransactionReceipt({ hash: txHash })
      return createHashCredential({ challenge: c.challenge, hash: txHash })
    }
  }
}

function randomNonce(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let hex: Hex = '0x'
  for (const b of bytes) hex = `${hex}${b.toString(16).padStart(2, '0')}` as Hex
  return BigInt(hex)
}
