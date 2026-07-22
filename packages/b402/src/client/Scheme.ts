import type {
  PaymentPayloadResult,
  PaymentRequirements as X402PaymentRequirements,
  SchemeNetworkClient,
} from '@x402/core/types'
import { type Account, getAddress, type LocalAccount } from 'viem'

import { buildEip3009Payment, type BuildEip3009PaymentOptions } from '../Payload.js'
import {
  B402_PERMIT2_ADDRESS,
  buildPermit2ExactPayment,
  type BuildPermit2ExactPaymentOptions,
} from '../Permit2.js'
import { parseB402PaymentRequirements } from '../Requirements.js'
import type { AssetTransferMethod } from '../Types.js'
import { B402Permit2ApprovalRequiredError, type B402Permit2AllowanceReader } from './Allowance.js'

export type B402ExactClientSchemeOptions = {
  readonly account: Account & {
    readonly signTypedData?: (parameters: any) => Promise<`0x${string}`>
  }
  readonly methods?: readonly AssetTransferMethod[] | undefined
  readonly permit2Allowance?: B402Permit2AllowanceReader | undefined
  readonly trustedSpenders?: Readonly<Record<string, readonly string[]>> | undefined
}

/** Official x402 client Scheme Adapter for B402 Exact EIP-3009 and Permit2 Exact. */
export class B402ExactClientScheme implements SchemeNetworkClient {
  readonly scheme = 'exact'
  readonly #options: B402ExactClientSchemeOptions

  constructor(options: B402ExactClientSchemeOptions) {
    this.#options = options
  }

  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: X402PaymentRequirements,
  ): Promise<PaymentPayloadResult> {
    if (x402Version !== 2) throw new Error(`B402 only supports x402 v2 (got v${x402Version})`)
    if (!this.#options.account.signTypedData) {
      throw new Error('B402 Exact requires a typed-data signer')
    }

    const requirements = parseB402PaymentRequirements(paymentRequirements)
    const method = requirements.extra.assetTransferMethod
    if (this.#options.methods && !this.#options.methods.includes(method)) {
      throw new Error(`B402 transfer method is not enabled: ${method}`)
    }

    if (method === 'eip3009') {
      const payment = await buildEip3009Payment({
        account: this.#options.account as LocalAccount,
        requirements,
      } satisfies BuildEip3009PaymentOptions)
      return { payload: { ...payment.payload }, x402Version }
    }

    const trustedSpenders = this.#options.trustedSpenders?.[requirements.network]
    if (!trustedSpenders?.length) {
      throw new Error(
        `B402 permit2-exact requires non-empty trustedSpenders for ${requirements.network}`,
      )
    }
    await this.#assertPermit2Allowance(
      requirements.network,
      requirements.asset,
      requirements.amount,
    )
    const payment = await buildPermit2ExactPayment({
      account: this.#options.account as LocalAccount,
      requirements,
      trustedSpenders,
    } satisfies BuildPermit2ExactPaymentOptions)
    return { payload: { ...payment.payload }, x402Version }
  }

  async #assertPermit2Allowance(network: string, token: `0x${string}`, amount: string) {
    const readAllowance = this.#options.permit2Allowance
    if (!readAllowance) {
      throw new Error(
        'B402 permit2-exact requires permit2Allowance so allowance is checked before signing',
      )
    }
    const owner = getAddress(this.#options.account.address)
    const currentAllowance = await readAllowance({
      network,
      owner,
      spender: B402_PERMIT2_ADDRESS,
      token,
    })
    const requiredAmount = BigInt(amount)
    if (currentAllowance < requiredAmount) {
      throw new B402Permit2ApprovalRequiredError({
        currentAllowance,
        network,
        owner,
        requiredAmount,
        spender: B402_PERMIT2_ADDRESS,
        token,
      })
    }
  }
}
