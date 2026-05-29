/**
 * Builds the `Method.toServer` `defaults` object for the EVM Charge factory
 * (spec §10). Pure reshape of a resolved-params context into the wire-shaped
 * defaults bag — no RPC, no validation.
 */

import type { CredentialType } from '../../Methods.js'
import type { Split } from './types.js'

/**
 * Context the defaults builder closes over. Mirrors the locals `charge()`
 * derives from `prepared._resolved` + `params`.
 */
export interface BuildDefaultsCtx {
  readonly amount: string | undefined
  readonly currency: `0x${string}`
  readonly recipient: `0x${string}`
  readonly description: string | undefined
  readonly externalId: string | undefined
  readonly chainId: number
  readonly permit2Address: `0x${string}`
  /**
   * Settlement signer's EOA address — `undefined` for hash/transaction-only
   * deployments. Included in methodDetails iff configured.
   */
  readonly permit2Spender: `0x${string}` | undefined
  readonly resolvedCredentialTypes: readonly CredentialType[]
  readonly decimals: number
  readonly splits: readonly Split[] | undefined
}

/**
 * defaults: ALL REQUIRED methodDetails fields must be present here.
 * mppx createMethodFn parses `{ ...defaults, ...rest }` directly via
 * schema.request.parse (src/server/Mppx.ts L1231 path), bypassing
 * request hook. Anything that schema declares REQUIRED MUST be in
 * defaults (or rest, but route options typically only pass amount).
 */
export function buildDefaults(ctx: BuildDefaultsCtx) {
  const {
    amount,
    currency,
    recipient,
    description,
    externalId,
    chainId,
    permit2Address,
    permit2Spender,
    resolvedCredentialTypes,
    decimals,
    splits,
  } = ctx
  return {
    ...(amount !== undefined && { amount }),
    currency,
    recipient,
    ...(description !== undefined && { description }),
    ...(externalId !== undefined && { externalId }),
    methodDetails: {
      chainId,
      permit2Address,
      // Settlement signer address — included iff configured. Required
      // for permit2/authorization (Permit2 uses msg.sender as spender,
      // so the user MUST sign with this address; without it client-
      // signed typed data won't match on-chain Permit2 hash → revert
      // InvalidSigner). For hash/transaction-only deployments this is
      // undefined and gets stripped from the wire challenge.
      ...(permit2Spender !== undefined && { permit2Spender }),
      // Spread to a mutable copy — the schema's array type is mutable
      // even though our resolved value is readonly internally.
      credentialTypes: [...resolvedCredentialTypes],
      decimals,
      ...(splits !== undefined && { splits: [...splits] }),
    },
  }
}
