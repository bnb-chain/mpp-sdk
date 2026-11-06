import { Store } from 'mppx'
import { afterEach, expect, test, vi } from 'vitest'

import {
  b402ReplayKey,
  reserveB402Slot,
  markB402Consumed,
  markB402Rejected,
} from '../../packages/b402/src/server/Replay.js'
import { type ChargeStore, reserve, markConsumed, markRejected, txHashKey } from './Replay.js'

afterEach(() => vi.restoreAllMocks())

test('stale owners cannot consume or reject successor reservations in either replay implementation', async () => {
  const store = Store.memory() as ChargeStore
  const key = txHashKey(56, `0x${'12'.repeat(32)}`)
  const bkey = b402ReplayKey({
    transferMethod: 'eip3009',
    network: 'eip155:56',
    asset: '0x11',
    payer: '0x22',
    nonce: '1',
  })
  const first = await reserve(store, key, { inflightTtlMs: 1 })
  const bfirst = await reserveB402Slot(store, bkey, { inflightTtlMs: 1 })
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
  const next = await reserve(store, key, { inflightTtlMs: 1 })
  const bnext = await reserveB402Slot(store, bkey, { inflightTtlMs: 1 })
  expect(next).not.toBe(first)
  expect(bnext).not.toBe(bfirst)
  await markConsumed(store, key, first!)
  await markRejected(store, key, 'stale', first!)
  await markB402Consumed(store, bkey, bfirst!)
  await markB402Rejected(store, bkey, 'stale', bfirst!)
  expect(await store.get(key)).toMatchObject({ state: 'inflight', token: next })
  expect(await store.get(bkey)).toMatchObject({ state: 'inflight', token: bnext })
  await markConsumed(store, key, next!)
  await markB402Consumed(store, bkey, bnext!)
  expect(await store.get(key)).toMatchObject({ state: 'consumed' })
  expect(await store.get(bkey)).toMatchObject({ state: 'consumed' })
})
