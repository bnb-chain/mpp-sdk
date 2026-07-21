/**
 * Shared MPP wire contract for the provider-specific `b402/charge` method.
 *
 * Client and server import this exact Method instance. Human-readable route
 * amounts and server-only provider snapshots are accepted as input, then
 * normalized into the atomic, HMAC-bound Challenge request.
 */

import { Method, z } from 'mppx'
import { getAddress, parseUnits } from 'viem'

import type { Eip3009Authorization, Permit2Authorization } from './Types.js'

export const B402_CHARGE_PROTOCOL_VERSION = 1 as const
export const b402ChargeTransferMethods = ['eip3009', 'permit2-exact'] as const
export type B402ChargeTransferMethod = (typeof b402ChargeTransferMethods)[number]

const address = z.address()
const atomicAmount = z
  .string()
  .check(z.regex(/^[1-9]\d*$/, 'amount must be a positive atomic-unit integer'))
const decimalUint = z.string().check(z.regex(/^\d+$/, 'expected decimal uint256 string'))
const bytes32 = z.hash()
const signature = z
  .string()
  .check(
    z.regex(
      /^0x([0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/,
      'expected a 64-byte or 65-byte EVM signature',
    ),
  )
const permit2Signature = z
  .string()
  .check(z.regex(/^0x[0-9a-fA-F]{130}$/, 'expected a 65-byte Permit2 signature'))
const network = z
  .string()
  .check(z.regex(/^eip155:\d+$/, "network must use the 'eip155:<chainId>' CAIP-2 form"))

const providerSnapshot = z.object({
  signerAddress: address,
  spenderAddress: z.optional(address),
})

const providerSnapshots = z.object({
  eip3009: z.optional(providerSnapshot),
  permit2Exact: z.optional(providerSnapshot),
})

const requestInput = z.object({
  amount: z.amount(),
  currency: address,
  decimals: z
    .number()
    .check(z.refine(Number.isInteger, 'decimals must be an integer'), z.gte(0), z.lte(36)),
  description: z.optional(z.string()),
  externalId: z.optional(z.string()),
  maxTimeoutSeconds: z
    .number()
    .check(z.refine(Number.isInteger, 'maxTimeoutSeconds must be an integer'), z.positive()),
  network,
  providerSnapshot: z.optional(providerSnapshot),
  providerSnapshots: z.optional(providerSnapshots),
  recipient: address,
  tokenName: z.string().check(z.minLength(1)),
  tokenVersion: z.string().check(z.minLength(1)),
  transferMethod: z.enum(b402ChargeTransferMethods),
})

const request = z.pipe(
  requestInput,
  z.transform((input) => {
    const snapshot =
      input.providerSnapshot ??
      (input.transferMethod === 'eip3009'
        ? input.providerSnapshots?.eip3009
        : input.providerSnapshots?.permit2Exact)
    if (!snapshot) throw new Error('b402 charge requires a resolved provider snapshot')
    if (input.transferMethod === 'permit2-exact' && !snapshot.spenderAddress) {
      throw new Error('b402 permit2-exact requires a provider spenderAddress')
    }

    const amount = parseUnits(input.amount, input.decimals)
    if (amount <= 0n) throw new Error('b402 charge amount must be positive')

    return {
      amount: amount.toString(),
      currency: getAddress(input.currency),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
      methodDetails: {
        assetTransferMethod: input.transferMethod,
        decimals: input.decimals,
        eip712: {
          name: input.tokenName,
          version: input.tokenVersion,
        },
        maxTimeoutSeconds: input.maxTimeoutSeconds,
        network: input.network,
        protocolVersion: B402_CHARGE_PROTOCOL_VERSION,
        signerAddress: getAddress(snapshot.signerAddress),
        ...(snapshot.spenderAddress !== undefined
          ? { spenderAddress: getAddress(snapshot.spenderAddress) }
          : {}),
      },
      recipient: getAddress(input.recipient),
    } satisfies B402ChargeRequest
  }),
)

const credentialPayload = z.discriminatedUnion('type', [
  z.object({
    authorization: z.object({
      from: address,
      nonce: bytes32,
      to: address,
      validAfter: decimalUint,
      validBefore: decimalUint,
      value: atomicAmount,
    }),
    signature,
    type: z.literal('eip3009'),
  }),
  z.object({
    permit2Authorization: z.object({
      deadline: decimalUint,
      from: address,
      nonce: decimalUint,
      permitted: z.object({
        amount: atomicAmount,
        token: address,
      }),
      spender: address,
      witness: z.object({
        to: address,
        validAfter: decimalUint,
      }),
    }),
    signature: permit2Signature,
    type: z.literal('permit2-exact'),
  }),
])

export const chargeMethod = Method.from({
  intent: 'charge',
  name: 'b402',
  schema: {
    credential: { payload: credentialPayload },
    request,
  },
})

export type B402ChargeMethodDetails = {
  assetTransferMethod: B402ChargeTransferMethod
  decimals: number
  eip712: {
    name: string
    version: string
  }
  maxTimeoutSeconds: number
  network: string
  protocolVersion: typeof B402_CHARGE_PROTOCOL_VERSION
  signerAddress: `0x${string}`
  spenderAddress?: `0x${string}`
}

export type B402ChargeRequest = {
  amount: string
  currency: `0x${string}`
  description?: string
  externalId?: string
  methodDetails: B402ChargeMethodDetails
  recipient: `0x${string}`
}

export type B402Eip3009CredentialPayload = {
  authorization: Eip3009Authorization
  signature: `0x${string}`
  type: 'eip3009'
}

export type B402Permit2CredentialPayload = {
  permit2Authorization: Permit2Authorization
  signature: `0x${string}`
  type: 'permit2-exact'
}

export type B402ChargeCredentialPayload =
  | B402Eip3009CredentialPayload
  | B402Permit2CredentialPayload
