import type {
  AssetAmount,
  MoneyParser,
  Network,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SupportedKind,
} from '@x402/core/types'
import { getAddress } from 'viem'

import { parseB402PaymentRequirements } from '../Requirements.js'
import { X402_VERSION, type AssetTransferMethod } from '../Types.js'

export type B402SupportedProvider = {
  getSupported(): Promise<{
    readonly kinds: readonly {
      readonly x402Version: number
      readonly scheme: string
      readonly network: string
      readonly extra?: Readonly<Record<string, unknown>> | undefined
    }[]
  }>
}

export type B402ExactServerSchemeOptions = {
  readonly facilitator: B402SupportedProvider
  readonly moneyParser?: MoneyParser | undefined
}

/** Official x402 resource-server Scheme Adapter for both B402 Exact transfer methods. */
export class B402ExactServerScheme implements SchemeNetworkServer {
  readonly scheme = 'exact'
  readonly #options: B402ExactServerSchemeOptions

  constructor(options: B402ExactServerSchemeOptions) {
    this.#options = options
  }

  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (typeof price === 'object') {
      if (!/^[1-9]\d*$/.test(price.amount)) {
        throw new Error('B402 route price.amount must be a positive atomic-unit integer')
      }
      return {
        amount: price.amount,
        asset: getAddress(price.asset),
        ...(price.extra ? { extra: { ...price.extra } } : {}),
      }
    }

    const amount = typeof price === 'number' ? price : Number(price.replace(/^\$/, ''))
    if (!Number.isFinite(amount) || amount <= 0 || !this.#options.moneyParser) {
      throw new Error(
        'B402 monetary prices require a moneyParser; otherwise pass { asset, amount } in atomic units',
      )
    }
    const parsed = await this.#options.moneyParser(amount, network)
    if (!parsed) throw new Error(`B402 moneyParser cannot price ${String(price)} on ${network}`)
    return parsed
  }

  async enhancePaymentRequirements(
    input: PaymentRequirements,
    _supportedKind: SupportedKind,
  ): Promise<PaymentRequirements> {
    const method = parseTransferMethod(input.extra['assetTransferMethod'])
    const name = nonEmptyString(input.extra['name'], 'extra.name')
    const version = nonEmptyString(input.extra['version'], 'extra.version')
    const supported = await this.#options.facilitator.getSupported()
    const kind = supported.kinds.find(
      (candidate) =>
        candidate.x402Version === X402_VERSION &&
        candidate.scheme === 'exact' &&
        candidate.network === input.network &&
        candidate.extra?.['assetTransferMethod'] === method &&
        candidate.extra?.['name'] === name &&
        candidate.extra?.['version'] === version,
    )
    if (!kind?.extra) {
      throw new Error(
        `B402 /supported has no exact/${method} kind named '${name}' ` +
          `(version '${version}') on ${input.network}`,
      )
    }

    const requirements = parseB402PaymentRequirements({
      ...input,
      extra: {
        assetTransferMethod: method,
        name,
        signerAddress: kind.extra['signerAddress'],
        ...(kind.extra['spenderAddress'] !== undefined
          ? { spenderAddress: kind.extra['spenderAddress'] }
          : {}),
        version,
      },
    })
    return {
      ...requirements,
      network: requirements.network as Network,
      extra: { ...requirements.extra },
    }
  }

  validateFacilitatorSupport(network: Network, supportedKind: SupportedKind): string | undefined {
    if (!/^eip155:\d+$/.test(network)) return `B402 does not support network ${network}`
    if (supportedKind.x402Version !== X402_VERSION || supportedKind.scheme !== 'exact') {
      return `B402 requires x402 v2 exact support on ${network}`
    }
    return undefined
  }
}

function parseTransferMethod(value: unknown): AssetTransferMethod {
  if (value !== 'eip3009' && value !== 'permit2-exact') {
    throw new Error("B402 route extra.assetTransferMethod must be 'eip3009' or 'permit2-exact'")
  }
  return value
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`B402 route ${field} must be a non-empty string`)
  }
  return value
}
