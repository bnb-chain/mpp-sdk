/**
 * Request-hook route-override guard for the EVM Charge factory
 * (spec §10 / §14.10). Builds the `request` hook that mppx calls after
 * merging factory defaults with route options, rejecting any route option
 * that tries to override a server-configured field.
 */

import { Errors, type Method } from 'mppx'

import type { chargeMethod } from '../../Methods.js'
import type { Split } from './types.js'

/**
 * Structural splits compare. Object-key ORDER is not semantically
 * meaningful (`{recipient, amount, memo}` and `{amount, recipient, memo}`
 * describe the same split), so we compare field-by-field rather than by
 * serialized string. Splits ARRAY order IS spec-meaningful (draft §4.2.3 —
 * primary = index 0, then each declared split in order). Addresses
 * lowercase, amounts as BigInt.
 */
export function splitsEqual(
  a: readonly Split[] | undefined,
  b: ReadonlyArray<{ recipient: string; amount: string; memo?: string }> | undefined,
): boolean {
  if (a === undefined || a.length === 0) return b === undefined || b.length === 0
  if (b === undefined) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!
    const bv = b[i]!
    if (av.recipient.toLowerCase() !== bv.recipient.toLowerCase()) return false
    let aAmount: bigint
    let bAmount: bigint
    try {
      aAmount = BigInt(av.amount)
      bAmount = BigInt(bv.amount)
    } catch {
      return false
    }
    if (aAmount !== bAmount) return false
    // memo: both undefined ≡ equal; both present + string-equal ≡ equal;
    // anything else mismatches (presence is significant — empty-string is
    // distinct from absent in wire JSON).
    if (av.memo !== bv.memo) return false
  }
  return true
}

/**
 * Context the request hook closes over. `*Lower` fields are the
 * lowercased server-configured ground-truth values; `*Key` is the
 * order-sensitive JSON encoding of the credentialTypes preference list.
 */
export interface RequestHookCtx {
  readonly currency: `0x${string}`
  readonly chainId: number
  readonly decimals: number
  readonly resolvedCurrencyLower: string
  readonly resolvedRecipientLower: string
  readonly resolvedPermit2Lower: string
  readonly resolvedPermit2SpenderLower: string | undefined
  readonly resolvedCredentialTypesKey: string
  /**
   * Settlement signer address — `undefined` for hash/transaction-only
   * deployments. Gates whether `permit2Spender` is part of the protected
   * completeness set.
   */
  readonly permit2Spender: `0x${string}` | undefined
  readonly splits: readonly Split[] | undefined
}

/**
 * request hook (spec §10 / §14.10 route override guard).
 *
 * mppx merges defaults + route options into `r` BEFORE calling this
 * hook on the verify path. Compare every protected field to the
 * server-configured value; if a route option tried to override, the
 * merged result mismatches → throw. Only `amount` / `description` /
 * `externalId` are allowed to vary per route.
 *
 * mppx-managed mode also catches this via HMAC mismatch later, but
 * the explicit guard gives a deterministic, specific error message
 * and protects the bare-verify (mppx-hmac / stored-lookup) paths
 * that don't go through the framework HMAC layer.
 */
export function makeRequestHook(
  ctx: RequestHookCtx,
): NonNullable<Parameters<typeof Method.toServer<typeof chargeMethod>>[1]['request']> {
  const {
    currency,
    chainId,
    decimals,
    resolvedCurrencyLower,
    resolvedRecipientLower,
    resolvedPermit2Lower,
    resolvedPermit2SpenderLower,
    resolvedCredentialTypesKey,
    permit2Spender,
    splits,
  } = ctx
  return function request({ request: r }) {
    const merged = r as {
      currency?: string
      recipient?: string
      methodDetails?: {
        chainId?: number
        permit2Address?: string
        permit2Spender?: string
        credentialTypes?: readonly string[]
        decimals?: number
        splits?: ReadonlyArray<{ recipient: string; amount: string; memo?: string }>
      }
    }
    if (merged.currency !== undefined && merged.currency.toLowerCase() !== resolvedCurrencyLower) {
      throw new Errors.InvalidChallengeError({
        reason: `route option 'currency' (${merged.currency}) cannot override server-configured value (${currency})`,
      })
    }
    if (
      merged.recipient !== undefined &&
      merged.recipient.toLowerCase() !== resolvedRecipientLower
    ) {
      throw new Errors.InvalidChallengeError({
        reason: `route option 'recipient' cannot override server-configured value`,
      })
    }
    const md = merged.methodDetails
    if (md !== undefined) {
      // ─── (1) Existing value-mismatch checks on PRESENT fields ──────────
      //
      // These give the most-actionable per-field error when the caller
      // explicitly passed a different value (vs. just forgetting to pass
      // the field). Order matters: a more-specific mismatch should win
      // over the partial-methodDetails error from step (2).
      if (md.chainId !== undefined && md.chainId !== chainId) {
        throw new Errors.InvalidChallengeError({
          reason: `route option 'methodDetails.chainId' (${md.chainId}) cannot override server-configured value (${chainId})`,
        })
      }
      if (
        md.permit2Address !== undefined &&
        md.permit2Address.toLowerCase() !== resolvedPermit2Lower
      ) {
        throw new Errors.InvalidChallengeError({
          reason: `route option 'methodDetails.permit2Address' cannot override server-configured value`,
        })
      }
      if (
        md.permit2Spender !== undefined &&
        md.permit2Spender.toLowerCase() !== (resolvedPermit2SpenderLower ?? '')
      ) {
        throw new Errors.InvalidChallengeError({
          reason: `route option 'methodDetails.permit2Spender' cannot override server-configured value`,
        })
      }
      if (md.credentialTypes !== undefined) {
        // Order-sensitive compare — see resolvedCredentialTypesKey comment.
        const got = JSON.stringify([...md.credentialTypes])
        if (got !== resolvedCredentialTypesKey) {
          throw new Errors.InvalidChallengeError({
            reason: `route option 'methodDetails.credentialTypes' cannot override server-configured value (mismatch incl. ordering)`,
          })
        }
      }
      if (md.decimals !== undefined && md.decimals !== decimals) {
        throw new Errors.InvalidChallengeError({
          reason: `route option 'methodDetails.decimals' cannot override server-configured value`,
        })
      }
      if (md.splits !== undefined) {
        // Structural compare (drop JSON.stringify key-order dependency).
        if (!splitsEqual(splits, md.splits)) {
          throw new Errors.InvalidChallengeError({
            reason: `route option 'methodDetails.splits' cannot override server-configured value`,
          })
        }
      }
      // ─── (2) Completeness check: forbid PARTIAL methodDetails ──────────
      //
      // mppx's request merge is SHALLOW — a route option that passes
      // ANY `methodDetails` REPLACES `defaults.methodDetails` wholesale,
      // silently dropping any field the route didn't repeat. Previously
      // the present-field checks above silently let that happen because
      // they only fired on inequality, never on absence. The resulting
      // wire challenge would lose `credentialTypes` / `decimals` / `splits`,
      // and client constructors would then correctly reject
      // because the challenge's accepted-types set defaulted to
      // `['transaction','hash']` per spec §4.2.2.
      //
      // Policy: route options MUST EITHER omit `methodDetails` entirely
      // (defaults apply intact) OR provide every server-protected field.
      // No middle ground — partial methodDetails is a strict error.
      const missing: string[] = []
      if (md.chainId === undefined) missing.push('chainId')
      if (md.permit2Address === undefined) missing.push('permit2Address')
      if (md.credentialTypes === undefined) missing.push('credentialTypes')
      if (md.decimals === undefined) missing.push('decimals')
      // permit2Spender is part of the protected set ONLY when the
      // server has configured a settlementAccount — hash/transaction-only
      // deployments legitimately omit it.
      if (permit2Spender !== undefined && md.permit2Spender === undefined) {
        missing.push('permit2Spender')
      }
      // splits is part of the protected set ONLY when the server has
      // configured splits — otherwise omitting it is correct.
      if (splits !== undefined && md.splits === undefined) missing.push('splits')
      if (missing.length > 0) {
        throw new Errors.InvalidChallengeError({
          reason:
            `route option 'methodDetails' is partial — missing [${missing.join(', ')}]. ` +
            `Route options MUST either omit 'methodDetails' entirely (defaults apply ` +
            `intact) or provide every server-protected field (chainId, permit2Address, ` +
            `credentialTypes, decimals${
              splits !== undefined ? ', splits' : ''
            }). mppx merges shallowly, so a partial 'methodDetails' replaces ` +
            `defaults.methodDetails wholesale and silently drops the missing fields ` +
            `from the issued challenge — making client-side accepted-types checks ` +
            `(spec §4.2.2) reject downstream.`,
        })
      }
    }
    return r
  }
}
