import type { ChallengeStore } from './ChallengeStore.js'
import { chargeAsync, type ServerParameters } from './Charge.js'
import type { ChargeStore } from './Replay.js'

export type ProductionDeploymentProfile =
  | { readonly mode: 'mppx-managed' }
  | { readonly mode: 'mppx-hmac'; readonly secretKey: string }
  | { readonly mode: 'stored-lookup'; readonly challengeStore: ChallengeStore }

/**
 * Production-focused convenience parameters.
 *
 * The replay store is deliberately required here. The low-level
 * `chargeAsync(ServerParameters)` factory remains available for tests, local
 * development, and advanced configurations; this profile entry point removes
 * the unsafe memory fallback from the normal production call shape.
 */
export type ProductionChargeParameters = Omit<ServerParameters, 'challengeBinding' | 'store'> & {
  readonly profile: ProductionDeploymentProfile
  readonly store: ChargeStore
}

/**
 * Creates EVM Charge with an explicit replay store and a challenge-binding
 * profile. Profiles only package the challenge-binding choice; signer,
 * settlement, confirmations, and other independent policy remain visible.
 */
export async function productionCharge(
  parameters: ProductionChargeParameters,
): ReturnType<typeof chargeAsync> {
  return chargeAsync(resolveProductionParameters(parameters))
}

/**
 * @internal Pure profile expansion kept separate so the discriminated mapping
 * can be tested without an RPC preflight. Not exported from the public barrel.
 */
export function resolveProductionParameters(
  parameters: ProductionChargeParameters,
): ServerParameters {
  const { profile, ...base } = parameters
  switch (profile.mode) {
    case 'mppx-managed':
      return { ...base, challengeBinding: { mode: 'mppx-managed' } }
    case 'mppx-hmac':
      return {
        ...base,
        challengeBinding: { mode: 'mppx-hmac', secretKey: profile.secretKey },
      }
    case 'stored-lookup':
      return {
        ...base,
        challengeBinding: {
          mode: 'stored-lookup',
          challengeStore: profile.challengeStore,
        },
      }
  }
}
