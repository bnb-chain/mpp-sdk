import { describe, expect, test } from 'vitest'

import {
  B402ReplayStoreUnavailableError,
  b402ReplayKey,
  describeB402ReplayConflict,
  getB402ReplaySlot,
  markB402Consumed,
  markB402Rejected,
  releaseB402Slot,
  reserveB402Slot,
  type B402ReplayChange,
  type B402ReplayStore,
} from './Replay.js'

/** Map-backed atomic store — update() runs synchronously, like mppx Store.memory(). */
function memoryStore(): B402ReplayStore {
  const map = new Map<string, unknown>()
  return {
    get: async (key) => map.get(key) ?? null,
    update: async <result>(
      key: string,
      fn: (current: unknown) => B402ReplayChange<result>,
    ): Promise<result> => {
      const change = fn(map.get(key) ?? null)
      if (change.op === 'set') map.set(key, JSON.parse(JSON.stringify(change.value)))
      if (change.op === 'delete') map.delete(key)
      return change.result
    },
  }
}

const KEY = b402ReplayKey({
  asset: '0x337610d27c682E347C9cD60BD4b3b107C9d34dDd',
  network: 'eip155:97',
  nonce: `0x${'ab'.repeat(32)}`,
  payer: '0x1111111111111111111111111111111111111111',
  transferMethod: 'eip3009',
})

describe('b402ReplayKey', () => {
  test('canonicalizes case and numeric encodings so one nonce claims one slot', () => {
    const base = {
      asset: '0xAAaa000000000000000000000000000000000001',
      network: 'eip155:56',
      payer: '0xBBbb000000000000000000000000000000000002',
      transferMethod: 'permit2-exact',
    }
    expect(b402ReplayKey({ ...base, nonce: '0xAB' })).toBe(
      b402ReplayKey({ ...base, nonce: '0xab' }),
    )
    expect(b402ReplayKey({ ...base, nonce: '7' })).toBe(b402ReplayKey({ ...base, nonce: '07' }))
    expect(b402ReplayKey({ ...base, asset: base.asset.toLowerCase(), nonce: '7' })).toBe(
      b402ReplayKey({ ...base, nonce: '7' }),
    )
  })
})

describe('reserve / terminal states', () => {
  test('first reserve wins; duplicates conflict until released', async () => {
    const store = memoryStore()
    const token = await reserveB402Slot(store, KEY)
    expect(token).toBeTruthy()
    expect(await reserveB402Slot(store, KEY)).toBeNull()
    expect((await describeB402ReplayConflict(store, KEY)).state).toBe('inflight')

    await releaseB402Slot(store, KEY, token!)
    expect(await reserveB402Slot(store, KEY)).toBeTruthy()
  })

  test('exactly one of N concurrent reserves succeeds', async () => {
    const store = memoryStore()
    const tokens = await Promise.all(Array.from({ length: 8 }, () => reserveB402Slot(store, KEY)))
    expect(tokens.filter((t) => t !== null)).toHaveLength(1)
  })

  test('consumed is permanent — later rejects/releases cannot downgrade it', async () => {
    const store = memoryStore()
    const token = await reserveB402Slot(store, KEY)
    await markB402Consumed(store, KEY)

    await markB402Rejected(store, KEY, 'late loser')
    await releaseB402Slot(store, KEY, token!)
    expect(await getB402ReplaySlot(store, KEY)).toMatchObject({ state: 'consumed' })
    expect(await reserveB402Slot(store, KEY)).toBeNull()
  })

  test('rejected is permanent and keeps the FIRST reason', async () => {
    const store = memoryStore()
    await reserveB402Slot(store, KEY)
    await markB402Rejected(store, KEY, 'first reason')
    await markB402Rejected(store, KEY, 'second reason')
    expect(await describeB402ReplayConflict(store, KEY)).toEqual({
      reason: 'first reason',
      state: 'rejected',
    })
  })

  test('release requires the owning fencing token', async () => {
    const store = memoryStore()
    const token = await reserveB402Slot(store, KEY)
    await releaseB402Slot(store, KEY, 'not-the-token')
    expect(await getB402ReplaySlot(store, KEY)).toMatchObject({ state: 'inflight' })
    await releaseB402Slot(store, KEY, token!)
    expect(await getB402ReplaySlot(store, KEY)).toBeNull()
  })

  test('a stale inflight slot is reclaimed with a fresh token; the stranded release noops', async () => {
    const store = memoryStore()
    const stranded = await reserveB402Slot(store, KEY, { inflightTtlMs: 1 })
    await new Promise((resolve) => setTimeout(resolve, 5))

    // Staleness is judged by the RECLAIMING caller's TTL (the deployment's
    // uniform config) — the slot is 5ms old, past the 1ms TTL.
    const successor = await reserveB402Slot(store, KEY, { inflightTtlMs: 1 })
    expect(successor).toBeTruthy()
    expect(successor).not.toBe(stranded)

    await releaseB402Slot(store, KEY, stranded!)
    expect(await getB402ReplaySlot(store, KEY)).toMatchObject({ state: 'inflight' })
  })

  test('an unrecognized stored value fails closed (conflict, never overwritten)', async () => {
    const store = memoryStore()
    await store.update(KEY, () => ({
      op: 'set',
      value: { corrupt: true } as never,
      result: undefined,
    }))
    expect(await reserveB402Slot(store, KEY)).toBeNull()
    expect((await describeB402ReplayConflict(store, KEY)).state).toBe('unknown')
  })

  test('backend failures normalize to B402ReplayStoreUnavailableError', async () => {
    const broken: B402ReplayStore = {
      get: async () => {
        throw new Error('ECONNREFUSED')
      },
      update: async () => {
        throw new Error('ECONNREFUSED')
      },
    }
    await expect(reserveB402Slot(broken, KEY)).rejects.toBeInstanceOf(
      B402ReplayStoreUnavailableError,
    )
    await expect(getB402ReplaySlot(broken, KEY)).rejects.toMatchObject({ op: 'get', key: KEY })
  })
})
