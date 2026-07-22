import {
  X402_VERSION,
  isEip3009PaymentPayload,
  parseVerifyResult,
  type BazaarMetadata,
  type Eip3009PaymentPayload,
  type PaymentRequirements,
} from '@bnb-chain/b402'
import {
  B402SupportedCache,
  settleB402,
  type B402SettlementUnknownHandler,
  type B402Transport,
  type FacilitatorRequest,
} from '@bnb-chain/b402/server'
import { x402 } from 'mppx'
import { getAddress } from 'viem'

/**
 * Adapts B402 to mppx's standard x402 facilitator Interface.
 *
 * This compatibility seam is intentionally EIP-3009-only because mppx's
 * standard `evm/charge` wire does not model B402's `permit2-exact` witness.
 * Use the MPP-native `b402/charge` method for Permit2 Exact.
 */
export function createB402Facilitator(
  parameters: createB402Facilitator.Parameters,
): x402.Types.Facilitator {
  const supported = parameters.supportedCache ?? new B402SupportedCache(parameters.client)

  async function reconstruct(
    paymentPayload: x402.Types.PaymentPayload,
    paymentRequirements: x402.Types.PaymentRequirements,
    includeBazaar: boolean,
  ): Promise<{
    payer: `0x${string}`
    request: FacilitatorRequest
    requirements: PaymentRequirements
  }> {
    if (!('authorization' in paymentPayload.payload)) {
      throw new Error('createB402Facilitator only supports EIP-3009 authorization payloads')
    }
    const transferMethod = paymentRequirements.extra?.['assetTransferMethod']
    if (transferMethod !== 'eip3009') {
      throw new Error(
        `createB402Facilitator requires assetTransferMethod 'eip3009' (got ${String(transferMethod)})`,
      )
    }
    const name = paymentRequirements.extra?.['name']
    const version = paymentRequirements.extra?.['version']
    if (typeof name !== 'string' || !name || typeof version !== 'string' || !version) {
      throw new Error('createB402Facilitator requires token EIP-712 name and version')
    }

    const snapshot = await supported.get()
    const kind = snapshot.kinds.find(
      (candidate) =>
        candidate.x402Version === X402_VERSION &&
        candidate.scheme === 'exact' &&
        candidate.network === paymentRequirements.network &&
        candidate.extra.assetTransferMethod === 'eip3009' &&
        candidate.extra.name === name &&
        candidate.extra.version === version,
    )
    if (!kind) {
      throw new Error(
        `B402 /supported has no exact/eip3009 kind named '${name}' ` +
          `(version '${version}') on ${paymentRequirements.network}`,
      )
    }

    const requirements: PaymentRequirements = {
      amount: paymentRequirements.amount,
      asset: getAddress(paymentRequirements.asset),
      extra: {
        assetTransferMethod: 'eip3009',
        name: kind.extra.name,
        signerAddress: getAddress(kind.extra.signerAddress),
        version: kind.extra.version,
      },
      maxTimeoutSeconds: paymentRequirements.maxTimeoutSeconds,
      network: paymentRequirements.network,
      payTo: getAddress(paymentRequirements.payTo),
      scheme: 'exact',
    }
    const authorization = paymentPayload.payload.authorization
    const payment: Eip3009PaymentPayload = {
      accepted: requirements,
      ...(includeBazaar && parameters.bazaar ? { extensions: { bazaar: parameters.bazaar } } : {}),
      payload: {
        authorization: {
          from: getAddress(authorization.from),
          nonce: asBytes32(authorization.nonce),
          to: getAddress(authorization.to),
          validAfter: authorization.validAfter,
          validBefore: authorization.validBefore,
          value: authorization.value,
        },
        signature: asSignature(paymentPayload.payload.signature),
      },
      x402Version: X402_VERSION,
    }
    if (!isEip3009PaymentPayload(payment)) {
      throw new Error('B402 EIP-3009 payload does not satisfy the payment requirements')
    }
    return {
      payer: getAddress(authorization.from),
      request: {
        paymentPayload: payment,
        paymentRequirements: requirements,
        x402Version: X402_VERSION,
      },
      requirements,
    }
  }

  return {
    async verify(paymentPayload, paymentRequirements) {
      const reconstructed = await reconstruct(paymentPayload, paymentRequirements, false)
      const result = parseVerifyResult(await parameters.client.verify(reconstructed.request))
      if (result.isValid && result.payer.toLowerCase() !== reconstructed.payer.toLowerCase()) {
        return {
          invalidMessage: 'B402 verify payer does not match the signed payment',
          invalidReason: 'payer_mismatch',
          isValid: false,
          payer: result.payer,
        }
      }
      return result
    },

    async settle(paymentPayload, paymentRequirements) {
      const reconstructed = await reconstruct(paymentPayload, paymentRequirements, true)
      return settleB402({
        client: parameters.client,
        expectation: {
          payer: reconstructed.payer,
          requirements: reconstructed.requirements,
          transferMethod: 'eip3009',
        },
        ...(parameters.onSettlementUnknown
          ? { onSettlementUnknown: parameters.onSettlementUnknown }
          : {}),
        request: reconstructed.request,
      })
    },
  }
}

function asBytes32(value: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error('Invalid EIP-3009 nonce')
  return value as `0x${string}`
}

function asSignature(value: string): `0x${string}` {
  if (!/^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/.test(value)) {
    throw new Error('Invalid EIP-3009 signature')
  }
  return value as `0x${string}`
}

export declare namespace createB402Facilitator {
  export type Parameters = {
    readonly bazaar?: BazaarMetadata | undefined
    readonly client: B402Transport
    readonly onSettlementUnknown?: B402SettlementUnknownHandler | undefined
    readonly supportedCache?: B402SupportedCache | undefined
  }
}
