/**
 * @bnb-chain/mpp — top-level barrel.
 *
 * Provides the shared method instance (chargeMethod), the human-input
 * helper (chargeFromDecimal), and the wire Receipt codec (assert /
 * build / serialize / deserialize). The receipt codec is universal —
 * both client and server need to construct / parse Payment-Receipt
 * headers, and the impl uses only browser-safe primitives (Buffer is
 * polyfilled by bundlers).
 *
 * Server-side runtime lives under `@bnb-chain/mpp/server`;
 * client-side credential constructors under `@bnb-chain/mpp/client`.
 */

import { parseUnits } from 'viem'

export { chargeMethod, credentialTypes, type CredentialType } from './Methods.js'

// Receipt codec — universal (browser + server). The server barrel also
// re-exports these so existing server-side imports keep working without
// the deep `@bnb-chain/mpp/...` path.
export {
  assertEvmReceipt,
  buildEvmReceipt,
  deserializeEvmReceipt,
  type EvmReceipt,
  type EvmReceiptInput,
  serializeEvmReceipt,
} from './server/Receipt.js'

/* -------------------------------------------------------------------------- */
/*  chargeFromDecimal — human-input -> base-units helper (spec §6.5 Option A) */
/* -------------------------------------------------------------------------- */

/**
 * Convert a human-readable decimal amount (e.g. "1.23") into the
 * base-units integer string the wire schema requires.
 *
 * Ships Option A only (spec §6.5):
 *   - splits NOT supported here — splits live on ServerParameters.splits
 *     (spec §10 v1 invariant: splits only come from factory config, not
 *     from request input). Pre-convert splits[].amount yourself if needed,
 *     or wait for the splits-aware helper noted in §20.3 Future Work.
 *   - methodDetails NOT accepted — methodDetails is injected by the server
 *     factory's defaults (spec §10); request-input methodDetails would be
 *     rejected by the strict route guard anyway.
 *
 * Typical use at the route layer:
 *
 *   ```ts
 *   const request = chargeFromDecimal({ amount: '1.23', decimals: 6, recipient })
 *   const challenge = await handler.challenge.evm.charge(request)
 *   ```
 */
export interface ChargeFromDecimalInput {
  readonly amount: string | number
  readonly decimals: number
  readonly recipient?: `0x${string}`
  readonly description?: string
  readonly externalId?: string
  /** Type-level guard — splits go on ServerParameters, not request input. */
  readonly splits?: never
  /** Type-level guard — methodDetails comes from server factory defaults. */
  readonly methodDetails?: never
}

export interface ChargeFromDecimalOutput {
  readonly amount: string
  readonly recipient?: `0x${string}`
  readonly description?: string
  readonly externalId?: string
}

export function chargeFromDecimal(input: ChargeFromDecimalInput): ChargeFromDecimalOutput {
  // Runtime guards belt-and-suspenders the type-level `never` guards.
  if ((input as { splits?: unknown }).splits !== undefined) {
    throw new Error(
      'chargeFromDecimal does not support splits; v1 splits are configured on ' +
        'ServerParameters.splits, not on request input.',
    )
  }
  if ((input as { methodDetails?: unknown }).methodDetails !== undefined) {
    throw new Error(
      'chargeFromDecimal does not accept methodDetails; it is injected by the ' +
        'server factory defaults (spec §10).',
    )
  }
  const amount = parseUnits(String(input.amount), input.decimals).toString()
  return {
    amount,
    ...(input.recipient !== undefined && { recipient: input.recipient }),
    ...(input.description !== undefined && { description: input.description }),
    ...(input.externalId !== undefined && { externalId: input.externalId }),
  }
}
