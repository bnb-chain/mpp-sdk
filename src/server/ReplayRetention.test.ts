import { afterEach, expect, test, vi } from 'vitest'

import {
  consumeB402SlotBestEffort,
  b402ReplayKey,
  reserveB402Slot,
} from '../../packages/b402/src/server/Replay.js'
import {
  failOnState,
  terminalFailureStore,
} from '../../test/helpers/server/terminalFailureStore.js'
import { consumeSlotBestEffort } from './charge/verifierKit.js'
import { reserve, txHashKey } from './Replay.js'

afterEach(() => vi.restoreAllMocks())

test('protected core payment survives terminal-store failure and an expired inflight TTL', async () => {
  const store = terminalFailureStore({ failOn: failOnState('consumed') })
  const key = txHashKey(56, `0x${'12'.repeat(32)}`)
  await reserve(store, key, { inflightTtlMs: 1, preventReclaim: true })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  await consumeSlotBestEffort(store, key, 'test')
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
  expect(await reserve(store, key, { inflightTtlMs: 1 })).toBeNull()
  expect(await store.get(key)).toMatchObject({ state: 'inflight', preventReclaim: true })
})

test('protected B402 payment survives terminal-store failure and remains blocked after TTL', async () => {
  const store = terminalFailureStore({ failOn: failOnState('consumed') })
  const key = b402ReplayKey({
    transferMethod: 'eip3009',
    network: 'eip155:56',
    asset: '0x11',
    payer: '0x22',
    nonce: '1',
  })
  await reserveB402Slot(store, key, { inflightTtlMs: 1, preventReclaim: true })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  await consumeB402SlotBestEffort(store, key, 'test')
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
  expect(await reserveB402Slot(store, key, { inflightTtlMs: 1 })).toBeNull()
})
