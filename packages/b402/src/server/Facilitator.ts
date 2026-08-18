import type { FacilitatorClient as X402FacilitatorClient } from '@x402/core/server'
import type {
  Network,
  PaymentPayload as X402PaymentPayload,
  PaymentRequirements as X402PaymentRequirements,
  SettleResponse,
  SupportedResponse as X402SupportedResponse,
  VerifyResponse,
} from '@x402/core/types'
import { getAddress } from 'viem'

import { isEip3009PaymentPayload, recoverEip3009Payer } from '../Payload.js'
import { isPermit2PaymentPayload, recoverPermit2ExactPayer } from '../Permit2.js'
import { parseB402PaymentRequirements, sameB402PaymentRequirements } from '../Requirements.js'
import { parseVerifyResult } from '../Response.js'
import {
  X402_VERSION,
  type BazaarMetadata,
  type PaymentPayload,
  type PaymentRequirements,
} from '../Types.js'
import type { FacilitatorRequest } from './Client.js'
import { settleB402, type B402SettlementUnknownHandler } from './Settlement.js'
import { B402SupportedCache } from './Supported.js'
import type { B402Transport } from './Types.js'

export type B402FacilitatorClientOptions = {
  readonly bazaar?: BazaarMetadata | undefined
  readonly client: B402Transport
  readonly onSettlementUnknown?: B402SettlementUnknownHandler | undefined
  readonly supportedCache?: B402SupportedCache | undefined
}

/** Safe B402 Adapter for the official `@x402/core` FacilitatorClient Interface. */
export class B402FacilitatorClient implements X402FacilitatorClient {
  readonly #options: B402FacilitatorClientOptions
  readonly #supported: B402SupportedCache

  constructor(options: B402FacilitatorClientOptions) {
    this.#options = options
    this.#supported = options.supportedCache ?? new B402SupportedCache(options.client)
  }

  async getSupported(): Promise<X402SupportedResponse> {
    const response = await this.#supported.get()
    return {
      extensions: [...response.extensions],
      kinds: response.kinds.map((kind) => ({
        extra: { ...kind.extra },
        network: asNetwork(kind.network),
        scheme: kind.scheme,
        x402Version: kind.x402Version,
      })),
      signers: Object.fromEntries(
        Object.entries(response.signers).map(([network, signers]) => [network, [...signers]]),
      ),
    }
  }

  async verify(
    paymentPayload: X402PaymentPayload,
    paymentRequirements: X402PaymentRequirements,
  ): Promise<VerifyResponse> {
    let reconstructed: ReconstructedPayment
    try {
      reconstructed = await reconstructPayment(paymentPayload, paymentRequirements, false)
    } catch (cause) {
      return {
        invalidMessage: cause instanceof Error ? cause.message : 'Invalid B402 payment payload',
        invalidReason: 'invalid_payload',
        isValid: false,
      }
    }

    const result = parseVerifyResult(await this.#options.client.verify(reconstructed.request))
    if (result.isValid && !sameAddress(result.payer, reconstructed.payer)) {
      return {
        invalidMessage: 'B402 verify payer does not match the signed payment',
        invalidReason: 'payer_mismatch',
        isValid: false,
        payer: result.payer,
      }
    }
    return result
  }

  async settle(
    paymentPayload: X402PaymentPayload,
    paymentRequirements: X402PaymentRequirements,
  ): Promise<SettleResponse> {
    const reconstructed = await reconstructPayment(paymentPayload, paymentRequirements, true, {
      bazaar: this.#options.bazaar,
    })
    const result = await settleB402({
      client: this.#options.client,
      expectation: {
        payer: reconstructed.payer,
        requirements: reconstructed.requirements,
        transferMethod: reconstructed.requirements.extra.assetTransferMethod,
      },
      ...(this.#options.onSettlementUnknown
        ? { onSettlementUnknown: this.#options.onSettlementUnknown }
        : {}),
      request: reconstructed.request,
    })
    return {
      ...(result.amount !== undefined ? { amount: result.amount } : {}),
      ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
      ...(result.errorReason !== undefined ? { errorReason: result.errorReason } : {}),
      network: asNetwork(result.network),
      payer: result.payer,
      success: result.success,
      transaction: result.transaction,
    }
  }
}

type ReconstructedPayment = {
  payer: `0x${string}`
  request: FacilitatorRequest
  requirements: PaymentRequirements
}

async function reconstructPayment(
  input: X402PaymentPayload,
  requirementsInput: X402PaymentRequirements,
  includeMerchantExtensions: boolean,
  merchant: { readonly bazaar?: BazaarMetadata | undefined } = {},
): Promise<ReconstructedPayment> {
  if (input.x402Version !== X402_VERSION) {
    throw new Error(`B402 only supports x402 v2 (got v${input.x402Version})`)
  }
  const requirements = parseB402PaymentRequirements(requirementsInput)
  if (!sameB402PaymentRequirements(input.accepted, requirements)) {
    throw new Error('B402 payment accepted requirements do not match the merchant requirements')
  }

  let payment: PaymentPayload
  let payer: `0x${string}`
  if (requirements.extra.assetTransferMethod === 'eip3009') {
    const candidate: unknown = {
      accepted: requirements,
      payload: input.payload,
      x402Version: X402_VERSION,
    }
    if (!isEip3009PaymentPayload(candidate)) throw new Error('Malformed B402 EIP-3009 payload')
    payment = candidate
    // The eip3009 rail stays recover-and-compare: the facilitator only
    // accepts EOA signatures there (probed 2026-08-18 — an ERC-1271
    // envelope fails /verify with invalid_exact_evm_payload_signature), so
    // accepting anything a local recover cannot validate would only let
    // guaranteed rejections reach the network.
    payer = getAddress(await recoverEip3009Payer(candidate))
    if (!sameAddress(payer, candidate.payload.authorization.from)) {
      throw new Error('B402 EIP-3009 signature does not match authorization.from')
    }
  } else {
    const candidate: unknown = {
      accepted: requirements,
      payload: input.payload,
      x402Version: X402_VERSION,
    }
    if (!isPermit2PaymentPayload(candidate)) throw new Error('Malformed B402 Permit2 Exact payload')
    payment = candidate
    if (EOA_SIGNATURE_RE.test(candidate.payload.signature)) {
      payer = getAddress(await recoverPermit2ExactPayer(candidate))
      if (!sameAddress(payer, candidate.payload.permit2Authorization.from)) {
        throw new Error('B402 Permit2 signature does not match permit2Authorization.from')
      }
    } else {
      // Smart-account signature (ERC-1271/ERC-7739 envelope, longer than 65
      // bytes — e.g. Altana session keys, ERC-4337 wallets): it has no
      // recoverable key, so the local recover-and-compare gate cannot apply.
      // The facilitator validates it on-chain via the payer contract's
      // isValidSignature() at /verify and /settle (live on the permit2
      // rails since 2026-08). The declared `from` is the payer CLAIM used
      // for expectation bookkeeping; a forged claim cannot pass the
      // facilitator's on-chain check, and verify() cross-checks the
      // facilitator-reported payer against this claim.
      payer = getAddress(candidate.payload.permit2Authorization.from)
    }
  }

  if (includeMerchantExtensions && merchant.bazaar) {
    payment = { ...payment, extensions: { bazaar: merchant.bazaar } }
  }
  return {
    payer,
    request: {
      paymentPayload: payment,
      paymentRequirements: requirements,
      x402Version: X402_VERSION,
    },
    requirements,
  }
}

/** 65-byte r||s||v — the only shape a local ecrecover can validate. */
const EOA_SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/

function asNetwork(network: string): Network {
  if (!/^eip155:\d+$/.test(network)) throw new Error(`Invalid B402 network: ${network}`)
  return network as Network
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}
