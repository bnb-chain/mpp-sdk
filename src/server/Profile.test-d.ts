import { Store } from 'mppx'
import { test } from 'vitest'

import { productionCharge } from './Profile.js'
import type { ChargeStore } from './Replay.js'

const store = Store.memory() as ChargeStore
const common = {
  chain: 'ethereum',
  recipient: '0x2222222222222222222222222222222222222222',
  store,
  token: 'USDC',
} as const

test('productionCharge requires a replay store', async () => {
  await productionCharge({ ...common, profile: { mode: 'mppx-managed' } })

  // @ts-expect-error — production profile must never silently use Store.memory().
  await productionCharge({
    chain: 'ethereum',
    profile: { mode: 'mppx-managed' },
    recipient: common.recipient,
    token: 'USDC',
  })
})

test('profile-specific dependencies are encoded by the discriminated union', async () => {
  await productionCharge({
    ...common,
    profile: { mode: 'mppx-hmac', secretKey: 'deployment-secret' },
  })

  await productionCharge({
    ...common,
    // @ts-expect-error — mppx-hmac cannot be selected without its HMAC key.
    profile: { mode: 'mppx-hmac' },
  })

  await productionCharge({
    ...common,
    // @ts-expect-error — stored-lookup cannot be selected without a challenge store.
    profile: { mode: 'stored-lookup' },
  })
})
