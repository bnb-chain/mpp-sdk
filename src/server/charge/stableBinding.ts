/**
 * stableBinding hook for the EVM Charge factory (spec §14.10).
 *
 * mppx's default StableBindingFn pins only amount / currency / recipient
 * and methodDetails.chainId / splits. EVM Charge needs the rest of the
 * methodDetails fields (permit2Address / credentialTypes / decimals) in
 * the HMAC binding too, so a tampered challenge can't silently change
 * them while keeping the same id. `description` + `externalId` are
 * intentionally left out — they're free to vary per route.
 *
 * Pure request reshape — closes over no factory state, so the factory
 * takes no context.
 */

import type { Method } from 'mppx'

import type { chargeMethod } from '../../Methods.js'

/**
 * Builds the `stableBinding` hook. Augments mppx's default binding with
 * the EVM-Charge-specific methodDetails fields.
 */
export function makeStableBinding(): NonNullable<
  Parameters<typeof Method.toServer<typeof chargeMethod>>[1]['stableBinding']
> {
  return function stableBinding(req) {
    const r = req as typeof req & {
      methodDetails: {
        chainId: number
        permit2Address: string
        permit2Spender?: string
        credentialTypes?: readonly string[]
        decimals?: number
        splits?: ReadonlyArray<{ recipient: string; amount: string; memo?: string }>
      }
    }
    return {
      amount: r.amount,
      currency: r.currency,
      recipient: r.recipient,
      methodDetails: {
        chainId: r.methodDetails.chainId,
        permit2Address: r.methodDetails.permit2Address,
        // permit2Spender is bound into the HMAC so a tampered
        // challenge can't redirect the user's signed spender to a
        // different signer while keeping the same id.
        ...(r.methodDetails.permit2Spender !== undefined && {
          permit2Spender: r.methodDetails.permit2Spender,
        }),
        ...(r.methodDetails.credentialTypes !== undefined && {
          credentialTypes: r.methodDetails.credentialTypes,
        }),
        ...(r.methodDetails.decimals !== undefined && {
          decimals: r.methodDetails.decimals,
        }),
        ...(r.methodDetails.splits !== undefined && {
          splits: r.methodDetails.splits,
        }),
      },
    }
  }
}
