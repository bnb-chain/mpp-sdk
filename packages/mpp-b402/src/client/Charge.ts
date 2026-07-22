import {
  B402_PERMIT2_ADDRESS,
  buildEip3009Payment,
  buildPermit2ExactPayment,
  type BuildEip3009PaymentOptions,
  type BuildPermit2ExactPaymentOptions,
  type PaymentRequirements,
} from '@bnb-chain/b402'
import {
  B402Permit2ApprovalRequiredError,
  type B402AssetId,
  type B402Permit2AllowanceReader,
} from '@bnb-chain/b402/client'
import { Credential, evm, Method } from 'mppx'
import { type Account, getAddress, parseUnits, type LocalAccount } from 'viem'

import { chargeMethod, type B402ChargeRequest, type B402ChargeTransferMethod } from '../Methods.js'
import {
  preferB402Challenges,
  type B402ChallengeOrder,
  type B402MissingAllowanceBehavior,
} from './Prefer.js'

export function charge(parameters: charge.Parameters): charge.Client {
  const method = Method.toClient(chargeMethod, {
    async createCredential({ challenge }) {
      if (!parameters.account.signTypedData) {
        throw new Error('B402 charge requires a typed-data signer.')
      }
      const request = challenge.request as B402ChargeRequest
      assertPolicy(parameters, request)
      const requirements = toPaymentRequirements(request)
      const deadline = paymentDeadline(challenge.expires, request.methodDetails.maxTimeoutSeconds)

      if (request.methodDetails.assetTransferMethod === 'eip3009') {
        const payment = await buildEip3009Payment({
          account: parameters.account as LocalAccount,
          nonce: evm.Types.challengeHash(challenge),
          requirements,
          validBefore: deadline,
        } satisfies BuildEip3009PaymentOptions)
        return Credential.serialize({
          challenge,
          payload: {
            authorization: payment.payload.authorization,
            signature: payment.payload.signature,
            type: 'eip3009',
          },
        })
      }

      await assertPermit2Allowance(parameters, request)
      const payment = await buildPermit2ExactPayment({
        account: parameters.account as LocalAccount,
        deadline,
        nonce: evm.Types.challengeHash(challenge),
        requirements,
        trustedSpenders: trustedSpenders(parameters, request.methodDetails.network),
      } satisfies BuildPermit2ExactPaymentOptions)
      return Credential.serialize({
        challenge,
        payload: {
          permit2Authorization: payment.payload.permit2Authorization,
          signature: payment.payload.signature,
          type: 'permit2-exact',
        },
      })
    },
  })

  return Object.assign(method, {
    prefer(
      methods: readonly B402ChargeTransferMethod[],
      options: { onMissingAllowance?: B402MissingAllowanceBehavior | undefined } = {},
    ): B402ChallengeOrder {
      return preferB402Challenges({
        methods,
        onMissingAllowance: options.onMissingAllowance,
        canUsePermit2: (request) => canUsePermit2(parameters, request),
      })
    },
  }) as charge.Client
}

export declare namespace charge {
  type Client = Method.Client<typeof chargeMethod> & {
    prefer(
      methods: readonly B402ChargeTransferMethod[],
      options?: { onMissingAllowance?: B402MissingAllowanceBehavior | undefined },
    ): B402ChallengeOrder
  }

  type Signer = Account & {
    signTypedData?: (parameters: any) => Promise<`0x${string}`>
  }

  type Parameters = {
    account: Signer
    allowedCurrencies?: readonly B402AssetId[] | undefined
    allowedNetworks?: readonly string[] | undefined
    maxAmount?: string | undefined
    maxAtomicAmount?: string | bigint | undefined
    methods?: readonly B402ChargeTransferMethod[] | undefined
    permit2Allowance?: B402Permit2AllowanceReader | undefined
    trustedSpenders?: Readonly<Record<string, readonly string[]>> | undefined
  }
}

function assertPolicy(parameters: charge.Parameters, request: B402ChargeRequest): void {
  const method = request.methodDetails.assetTransferMethod
  if (parameters.methods && !parameters.methods.includes(method)) {
    throw new Error(`B402 transfer method is not allowed: ${method}.`)
  }
  if (
    parameters.allowedNetworks &&
    !parameters.allowedNetworks.includes(request.methodDetails.network)
  ) {
    throw new Error(`B402 network is not allowed: ${request.methodDetails.network}.`)
  }
  if (
    parameters.allowedCurrencies &&
    !parameters.allowedCurrencies.some(
      (currency) =>
        currency.network === request.methodDetails.network &&
        sameAddress(currency.address, request.currency),
    )
  ) {
    throw new Error(`B402 currency is not allowed: ${request.currency}.`)
  }
  if (
    parameters.maxAtomicAmount !== undefined &&
    BigInt(request.amount) > BigInt(parameters.maxAtomicAmount)
  ) {
    throw new Error('B402 charge amount exceeds maxAtomicAmount.')
  }
  if (
    parameters.maxAmount !== undefined &&
    BigInt(request.amount) > parseUnits(parameters.maxAmount, request.methodDetails.decimals)
  ) {
    throw new Error('B402 charge amount exceeds maxAmount.')
  }
  if (method === 'permit2-exact') trustedSpenders(parameters, request.methodDetails.network)
}

async function assertPermit2Allowance(
  parameters: charge.Parameters,
  request: B402ChargeRequest,
): Promise<void> {
  if (!parameters.permit2Allowance) {
    throw new Error(
      'B402 permit2-exact requires permit2Allowance so allowance is checked before signing.',
    )
  }
  const currentAllowance = await parameters.permit2Allowance({
    network: request.methodDetails.network,
    owner: getAddress(parameters.account.address),
    spender: B402_PERMIT2_ADDRESS,
    token: getAddress(request.currency),
  })
  const requiredAmount = BigInt(request.amount)
  if (currentAllowance < requiredAmount) {
    throw new B402Permit2ApprovalRequiredError({
      currentAllowance,
      network: request.methodDetails.network,
      owner: getAddress(parameters.account.address),
      requiredAmount,
      spender: B402_PERMIT2_ADDRESS,
      token: getAddress(request.currency),
    })
  }
}

async function canUsePermit2(
  parameters: charge.Parameters,
  request: B402ChargeRequest,
): Promise<boolean> {
  try {
    assertPolicy(parameters, request)
    await assertPermit2Allowance(parameters, request)
    return true
  } catch (error) {
    if (error instanceof B402Permit2ApprovalRequiredError) return false
    if (error instanceof Error && /requires permit2Allowance/.test(error.message)) return false
    throw error
  }
}

function trustedSpenders(parameters: charge.Parameters, network: string): readonly string[] {
  const spenders = parameters.trustedSpenders?.[network]
  if (!spenders?.length) {
    throw new Error(`B402 permit2-exact requires non-empty trustedSpenders for ${network}.`)
  }
  return spenders
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

function paymentDeadline(expires: string | undefined, maxTimeoutSeconds: number): bigint {
  const now = BigInt(Math.floor(Date.now() / 1000))
  const timeoutDeadline = now + BigInt(maxTimeoutSeconds)
  if (!expires) return timeoutDeadline
  const milliseconds = new Date(expires).getTime()
  if (!Number.isFinite(milliseconds)) throw new Error(`Invalid Challenge expiry: ${expires}`)
  const challengeDeadline = BigInt(Math.floor(milliseconds / 1000))
  const deadline = challengeDeadline < timeoutDeadline ? challengeDeadline : timeoutDeadline
  if (deadline <= now) throw new Error('B402 Challenge has expired.')
  return deadline
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}
