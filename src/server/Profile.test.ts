import { Store } from 'mppx'
import { describe, expect, test } from 'vitest'

import type { ChallengeStore } from './ChallengeStore.js'
import { type ProductionChargeParameters, resolveProductionParameters } from './Profile.js'
import type { ChargeStore } from './Replay.js'

const REPLAY_STORE = Store.memory() as ChargeStore
const CHALLENGE_STORE = Store.memory() as unknown as ChallengeStore

function base(profile: ProductionChargeParameters['profile']): ProductionChargeParameters {
  return {
    chain: 'ethereum',
    profile,
    recipient: '0x2222222222222222222222222222222222222222',
    store: REPLAY_STORE,
    token: 'USDC',
  }
}

describe('production deployment profiles', () => {
  test('maps mppx-managed without hiding independent settings', () => {
    const resolved = resolveProductionParameters({
      ...base({ mode: 'mppx-managed' }),
      confirmations: 12,
    })
    expect(resolved.challengeBinding).toEqual({ mode: 'mppx-managed' })
    expect(resolved.store).toBe(REPLAY_STORE)
    expect(resolved.confirmations).toBe(12)
  })

  test('maps mppx-hmac with its required secret', () => {
    const resolved = resolveProductionParameters(
      base({ mode: 'mppx-hmac', secretKey: 'profile-secret' }),
    )
    expect(resolved.challengeBinding).toEqual({
      mode: 'mppx-hmac',
      secretKey: 'profile-secret',
    })
  })

  test('maps stored-lookup with a distinct challenge store', () => {
    const resolved = resolveProductionParameters(
      base({ mode: 'stored-lookup', challengeStore: CHALLENGE_STORE }),
    )
    expect(resolved.challengeBinding).toEqual({
      mode: 'stored-lookup',
      challengeStore: CHALLENGE_STORE,
    })
    expect(resolved.store).toBe(REPLAY_STORE)
  })
})
