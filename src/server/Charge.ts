/**
 * EVM Charge server factory (spec §10).
 *
 * Public surface:
 *
 *   preflightCharge(params)  async — does all RPC + curated resolution.
 *                            Returns ResolvedChargeParams (params + _resolved
 *                            bag). Throws on misconfiguration before any
 *                            verifier ever runs (Permit2 not deployed +
 *                            user required it, credentialTypes empty,
 *                            authorization on non-EIP-3009 token, etc.).
 *
 *   charge(prepared)         sync — builds the Method.toServer instance from
 *                            ResolvedChargeParams. The two-step API exists
 *                            so callers can keep `charge()` sync inside
 *                            Mppx.create({ methods: [...] }) lists; the
 *                            async work is shifted to preflightCharge.
 *
 *   chargeAsync(params)      sync sugar = `charge(await preflightCharge(params))`.
 *
 * All four credential paths are live: hash + stored-lookup challenge
 * binding, transaction, permit2, authorization (EIP-3009).
 * The verify-hook routing + ctx propagation is wired here so verifier authors
 * only have to fill in the body.
 *
 * This module is the thin public seam. The internals live under
 * `src/server/charge/`:
 *   - types.ts        — the public/internal type surface
 *   - preflight.ts    — preflightCharge + preflightChargeInternal
 *   - defaults.ts     — buildDefaults (methodDetails incl. permit2Spender)
 *   - routeGuards.ts  — makeRequestHook + splitsEqual
 *   - stableBinding.ts— makeStableBinding (pure request reshape)
 *   - verifyRouter.ts — makeVerifyRouter (challenge-binding → accepted-types
 *                       gate → dispatch by payload.type)
 */

import { Method } from 'mppx'
import type { Transport } from 'mppx/server'

import { chargeMethod } from '../Methods.js'
import { buildDefaults } from './charge/defaults.js'
import { preflightCharge } from './charge/preflight.js'
import { makeRequestHook } from './charge/routeGuards.js'
import { makeStableBinding } from './charge/stableBinding.js'
import type {
  ChargeServerDefaults,
  PreflightInternalHooks,
  ResolvedChargeParams,
  ServerParameters,
} from './charge/types.js'
import { makeVerifyRouter } from './charge/verifyRouter.js'

/* -------------------------------------------------------------------------- */
/*  Public type surface — re-exported so @bnb-chain/mpp/server is unchanged.  */
/* -------------------------------------------------------------------------- */

export type {
  ChargeServerDefaults,
  ResolvedChargeParams,
  ServerParameters,
  Split,
} from './charge/types.js'

/**
 * @internal — test seam re-exports this type-only for typing the hooks shape.
 */
export type _PreflightInternalHooks = PreflightInternalHooks

/* -------------------------------------------------------------------------- */
/*  preflightCharge — re-exported from charge/preflight.js                    */
/* -------------------------------------------------------------------------- */

// `preflightCharge(params)` is single-arg public API. The test-only
// `preflightChargeInternal` + its hooks shape (`_PreflightInternalHooks`)
// are re-exported here so `test/helpers/server/preflightChargeForTest.ts`
// keeps importing them from this module. They stay un-exported from
// `@bnb-chain/mpp/server` (see src/server/index.ts) — production callers
// cannot bypass the Permit2 deployment probe / inject a fake publicClient /
// bypass the sentinel zero-address guard.
export { preflightCharge, preflightChargeInternal } from './charge/preflight.js'

/* -------------------------------------------------------------------------- */
/*  charge(prepared)                                                          */
/* -------------------------------------------------------------------------- */

export function charge(
  prepared: ResolvedChargeParams,
): Method.Server<typeof chargeMethod, ChargeServerDefaults, Transport.Http> {
  const params = prepared
  const {
    currency,
    decimals,
    chainId,
    permit2Address,
    resolvedCredentialTypes,
    publicClient,
    settlementSigner,
    settleBackend,
    store,
    verifyChallengeBinding,
    confirmations,
    eip712,
  } = prepared._resolved
  const { amount, recipient, description, externalId, splits } = params

  // Server-side ground truth used by the request hook + stableBinding +
  // verify-hook lookups. Captured once here so the closures below don't
  // have to re-destructure `prepared._resolved` on every invocation.
  const resolvedRecipientLower = recipient.toLowerCase()
  const resolvedCurrencyLower = currency.toLowerCase()
  const resolvedPermit2Lower = permit2Address.toLowerCase()
  // Settlement signer's EOA address — derived from `settlementAccount`
  // (mandatory for permit2/authorization). When the deployment doesn't
  // configure a signer (hash-only / transaction-only), this stays
  // undefined and is omitted from the issued challenge's methodDetails.
  const permit2Spender: `0x${string}` | undefined = settlementSigner?.account?.address
  const resolvedPermit2SpenderLower = permit2Spender?.toLowerCase()
  // credentialTypes is an ORDERED preference list per draft Table 2 (client
  // SHOULD use the first supported type). Compare as-is — re-ordering the
  // array MUST be rejected because it changes client behaviour.
  const resolvedCredentialTypesKey = JSON.stringify([...resolvedCredentialTypes])

  return Method.toServer(chargeMethod, {
    // —— defaults: ALL REQUIRED methodDetails fields must be present here.
    //    mppx parses `{ ...defaults, ...routeInput }` before the request hook.
    //    Anything the schema declares REQUIRED must therefore be in defaults
    //    (or route input, which typically carries only amount). The pinned
    //    behavior is guarded by the mppx contract tests.
    defaults: buildDefaults({
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
    }),

    // —— request hook (spec §10 / §14.10 route override guard) ────────────
    request: makeRequestHook({
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
    }),

    // —— stableBinding (spec §14.10) — augments mppx's default binding ─────
    stableBinding: makeStableBinding(),

    // —— verify hook: route by credential.payload.type ——
    verify: makeVerifyRouter({
      verifyChallengeBinding,
      publicClient,
      store,
      chainId,
      confirmations,
      settlementTimeoutMs: params.settlementTimeoutMs,
      inflightTtlMs: params.inflightTtlMs,
      hashFromPolicy: params.hashFromPolicy,
      settlementSigner,
      settleBackend,
      eip712,
    }),
  })
}

/**
 * Sugar — `charge(await preflightCharge(params))`. Return type uses the
 * same `ChargeServerDefaults` alias as `charge()` so call-site type
 * narrowing (route options optionality) is identical across both APIs.
 */
export async function chargeAsync(
  params: ServerParameters,
): Promise<Method.Server<typeof chargeMethod, ChargeServerDefaults, Transport.Http>> {
  return charge(await preflightCharge(params))
}

// All four verifier bodies (hash, transaction, permit2, authorization) are
// live. The earlier notImplemented stub has been removed.
