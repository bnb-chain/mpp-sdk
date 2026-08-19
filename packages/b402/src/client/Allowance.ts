import { B402_PERMIT2_ADDRESS } from '../Permit2.js'

export interface B402AssetId {
  readonly address: `0x${string}`
  readonly network: string
  /**
   * The token's TRUE decimals, declared by the buyer (audit M05). When a
   * spending ceiling (`maxAmount`) is configured, the human-readable →
   * atomic-units conversion MUST use this value — the wire-declared
   * `methodDetails.decimals` is merchant-controlled, and overstating it
   * inflates the computed ceiling by orders of magnitude.
   */
  readonly decimals?: number
}

export interface B402Permit2AllowanceQuery {
  readonly network: string
  readonly owner: `0x${string}`
  /** ERC-20 allowance target: canonical Permit2, not the B402 proxy. */
  readonly spender: typeof B402_PERMIT2_ADDRESS
  readonly token: `0x${string}`
}

export type B402Permit2AllowanceReader = (
  query: B402Permit2AllowanceQuery,
) => bigint | Promise<bigint>

export interface B402Permit2ApprovalRequest extends B402Permit2AllowanceQuery {
  readonly currentAllowance: bigint
  readonly requiredAmount: bigint
}

/** Raised before signing when the ERC-20 approval to canonical Permit2 is insufficient. */
export class B402Permit2ApprovalRequiredError extends Error {
  readonly approval: B402Permit2ApprovalRequest

  constructor(approval: B402Permit2ApprovalRequest) {
    super(
      `B402 permit2-exact requires ERC-20 approval to ${approval.spender}; ` +
        `allowance ${approval.currentAllowance} is below ${approval.requiredAmount}`,
    )
    this.name = 'B402Permit2ApprovalRequiredError'
    this.approval = approval
  }
}
