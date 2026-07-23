import {
  X402_VERSION,
  isEip3009PaymentPayload,
  isPermit2PaymentPayload,
  recoverEip3009Payer,
  recoverPermit2ExactPayer,
  type Eip3009PaymentPayload,
  type PaymentPayload,
  type PaymentRequirements,
  type Permit2PaymentPayload,
} from '@bnb-chain/b402'
import { Errors, evm } from 'mppx'
import { getAddress } from 'viem'

import type { B402ChargeCredentialPayload, B402ChargeRequest } from '../Methods.js'

export async function reconstructPayment(parameters: {
  credential: {
    readonly challenge: {
      readonly expires?: string | undefined
      readonly id: string
      readonly realm: string
    }
  }
  credentialPayload: B402ChargeCredentialPayload
  request: B402ChargeRequest
}): Promise<{
  payer: `0x${string}`
  payment: PaymentPayload
  requirements: PaymentRequirements
}> {
  const { credential, credentialPayload, request } = parameters
  const transferMethod = request.methodDetails.assetTransferMethod
  if (credentialPayload.type !== transferMethod) {
    throw new Errors.VerificationFailedError({
      reason: `B402 credential type ${credentialPayload.type} does not match ${transferMethod}`,
    })
  }

  const requirements = toPaymentRequirements(request)
  const expectedNonce = evm.Types.challengeHash(credential.challenge)
  const now = BigInt(Math.floor(Date.now() / 1000))
  const latestDeadline = maximumCredentialDeadline(
    now,
    request.methodDetails.maxTimeoutSeconds,
    credential.challenge.expires,
  )

  if (credentialPayload.type === 'eip3009') {
    const payment: Eip3009PaymentPayload = {
      accepted: requirements,
      payload: {
        authorization: credentialPayload.authorization,
        signature: credentialPayload.signature,
      },
      x402Version: X402_VERSION,
    }
    if (!isEip3009PaymentPayload(payment)) fail('malformed B402 EIP-3009 payment')
    if (payment.payload.authorization.nonce !== expectedNonce) {
      fail('B402 EIP-3009 nonce does not match the MPP Challenge')
    }
    if (BigInt(payment.payload.authorization.validAfter) > now) {
      fail('B402 EIP-3009 authorization is not valid yet')
    }
    if (BigInt(payment.payload.authorization.validBefore) <= now) {
      fail('B402 EIP-3009 authorization has expired')
    }
    if (BigInt(payment.payload.authorization.validBefore) > latestDeadline) {
      fail('B402 EIP-3009 authorization exceeds the Challenge settlement window')
    }
    const recovered = await recoverEip3009Payer(payment)
    assertAddressEqual(recovered, payment.payload.authorization.from, 'invalid EIP-3009 signature')
    return { payer: recovered, payment, requirements }
  }

  const payment: Permit2PaymentPayload = {
    accepted: requirements,
    payload: {
      permit2Authorization: credentialPayload.permit2Authorization,
      signature: credentialPayload.signature,
    },
    x402Version: X402_VERSION,
  }
  if (!isPermit2PaymentPayload(payment)) fail('malformed B402 permit2-exact payment')
  if (payment.payload.permit2Authorization.nonce !== BigInt(expectedNonce).toString()) {
    fail('B402 Permit2 nonce does not match the MPP Challenge')
  }
  if (BigInt(payment.payload.permit2Authorization.witness.validAfter) > now) {
    fail('B402 Permit2 authorization is not valid yet')
  }
  if (BigInt(payment.payload.permit2Authorization.deadline) <= now) {
    fail('B402 Permit2 authorization has expired')
  }
  if (BigInt(payment.payload.permit2Authorization.deadline) > latestDeadline) {
    fail('B402 Permit2 authorization exceeds the Challenge settlement window')
  }
  const recovered = await recoverPermit2ExactPayer(payment)
  assertAddressEqual(
    recovered,
    payment.payload.permit2Authorization.from,
    'invalid Permit2 signature',
  )
  return { payer: recovered, payment, requirements }
}

export function assertAddressEqual(actual: string, expected: string, reason: string): void {
  if (actual.toLowerCase() !== expected.toLowerCase()) fail(reason)
}

function maximumCredentialDeadline(
  now: bigint,
  maxTimeoutSeconds: number,
  expires: string | undefined,
): bigint {
  const timeoutDeadline = now + BigInt(maxTimeoutSeconds)
  if (!expires) return timeoutDeadline
  const milliseconds = new Date(expires).getTime()
  if (!Number.isFinite(milliseconds)) fail('invalid B402 Challenge expiry')
  const challengeDeadline = BigInt(Math.floor(milliseconds / 1000))
  return challengeDeadline < timeoutDeadline ? challengeDeadline : timeoutDeadline
}

function toPaymentRequirements(request: B402ChargeRequest): PaymentRequirements {
  return {
    amount: request.amount,
    asset: getAddress(request.currency),
    extra: {
      assetTransferMethod: request.methodDetails.assetTransferMethod,
      name: request.methodDetails.eip712.name,
      signerAddress: getAddress(request.methodDetails.signerAddress),
      ...(request.methodDetails.spenderAddress
        ? { spenderAddress: getAddress(request.methodDetails.spenderAddress) }
        : {}),
      version: request.methodDetails.eip712.version,
    },
    maxTimeoutSeconds: request.methodDetails.maxTimeoutSeconds,
    network: request.methodDetails.network,
    payTo: getAddress(request.recipient),
    scheme: 'exact',
  }
}

function fail(reason: string): never {
  throw new Errors.VerificationFailedError({ reason })
}
