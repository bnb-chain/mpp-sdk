import type { Address } from 'viem'

/** B402-local EIP-3009 typed data. Kept independent from the MPP wire package. */
export const eip3009Types = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

export function eip3009Domain(parameters: {
  tokenName: string
  tokenVersion: string
  chainId: number
  tokenAddress: Address
}) {
  return {
    name: parameters.tokenName,
    version: parameters.tokenVersion,
    chainId: parameters.chainId,
    verifyingContract: parameters.tokenAddress,
  } as const
}
