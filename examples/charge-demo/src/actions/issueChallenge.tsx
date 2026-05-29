/**
 * Step 1b: issue challenge locally (local mode).
 *
 * Constructs the wire `request` from form state, validates it against the
 * chargeMethod schema, and signs/binds the challenge per the selected
 * binding mode (mppx-managed / mppx-hmac / stored-lookup).
 */

import { chargeMethod } from '@bnb-chain/mpp'
import { Challenge } from 'mppx'

import { JsonBlock } from '@/components/JsonBlock'
import { PERMIT2_ADDRESS, getPresetByKey } from '@/protocol/presets.js'
import { type DemoState } from '@/state/types'

import {
  type ActionResult,
  DEMO_PERMIT2_SPENDER,
  DEMO_SECRET,
  panel,
  parseBaseUnitsOrThrow,
  safeBigInt,
} from './shared'

export function issueChallengeLocal(state: DemoState): ActionResult {
  const preset = getPresetByKey(state.chainKey)
  const amount = parseBaseUnitsOrThrow(state)

  // Splits are Permit2-only (draft §4.2.3). With per-credential-type
  // state pools the demo keeps `splits` across tab switches, so a
  // non-permit2 challenge may be issued while stale splits sit in
  // shared state — we simply IGNORE them here (the inclusion below is
  // gated on credentialType === 'permit2'), no throw. Only validate
  // split amounts when they'll actually be used.
  const includeSplits = state.credentialType === 'permit2' && state.splits.length > 0
  if (includeSplits) {
    for (const [i, s] of state.splits.entries()) {
      if (safeBigInt(s.amount) === null) {
        throw new Error(`Split #${i + 1} amount "${s.amount}" is not a valid base-units integer.`)
      }
    }
  }

  const request: Record<string, unknown> = {
    amount: amount.toString(),
    currency: preset.currency,
    recipient: state.recipient,
    methodDetails: {
      chainId: preset.chainId,
      permit2Address: PERMIT2_ADDRESS,
      // Permit2 credentials need a spender in the challenge so the
      // client signs the EIP-712 typed data with the right address.
      // Local mode has no server settlement signer — inject the
      // demo placeholder (see DEMO_PERMIT2_SPENDER doc).
      ...(state.credentialType === 'permit2' && { permit2Spender: DEMO_PERMIT2_SPENDER }),
      credentialTypes: [state.credentialType],
      decimals: preset.decimals,
      ...(includeSplits && {
        splits: state.splits.map((s) => ({ recipient: s.recipient, amount: s.amount })),
      }),
    },
  }
  try {
    chargeMethod.schema.request.parse(request)
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`Constructed request fails chargeMethod wire-schema validation: ${reason}`, {
      cause,
    })
  }

  let challenge: Challenge.Challenge
  if (state.bindingMode === 'stored-lookup') {
    challenge = Challenge.from({
      method: 'evm',
      intent: 'charge',
      realm: state.realm,
      request,
      expires: new Date(Date.now() + 60_000).toISOString(),
      id: `demo-stored-id-${Date.now().toString(36)}`,
    })
  } else {
    challenge = Challenge.from({
      method: 'evm',
      intent: 'charge',
      realm: state.realm,
      request,
      expires: new Date(Date.now() + 60_000).toISOString(),
      secretKey: DEMO_SECRET,
    })
  }

  const body = (
    <JsonBlock
      value={{
        id: challenge.id,
        method: challenge.method,
        intent: challenge.intent,
        realm: challenge.realm,
        request: challenge.request,
        expires: challenge.expires,
      }}
    />
  )
  return {
    patch: { challenge },
    panel: panel(`Challenge issued (binding mode: ${state.bindingMode})`, body),
  }
}
