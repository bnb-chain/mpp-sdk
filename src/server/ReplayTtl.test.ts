import { Store } from 'mppx'
import { expect, test } from 'vitest'

import { b402ReplayKey, reserveB402Slot } from '../../packages/b402/src/server/Replay.js'
import { type ChargeStore, reserve, txHashKey } from './Replay.js'

test.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'refuses invalid replay TTL %s in both stores before writing',
  async (inflightTtlMs) => {
    const store = Store.memory() as ChargeStore
    const key = txHashKey(56, `0x${'12'.repeat(32)}`)
    const bkey = b402ReplayKey({
      transferMethod: 'eip3009',
      network: 'eip155:56',
      asset: '0x11',
      payer: '0x22',
      nonce: '1',
    })
    await expect(reserve(store, key, { inflightTtlMs })).rejects.toThrow(/positive safe integer/)
    await expect(reserveB402Slot(store, bkey, { inflightTtlMs })).rejects.toThrow(
      /positive safe integer/,
    )
    expect(await store.get(key)).toBeNull()
    expect(await store.get(bkey)).toBeNull()
  },
)
