import { Store } from 'mppx'
import { describe, expect, test } from 'vitest'

import type { ChargeStore } from '../server/Replay.js'
import { replayStoreConformance, ReplayStoreConformanceError } from './ReplayStoreConformance.js'

describe('replayStoreConformance', () => {
  test('accepts mppx Store.memory atomic semantics', async () => {
    const store = Store.memory() as ChargeStore
    await expect(replayStoreConformance(() => store)).resolves.toBeUndefined()
  })

  test('detects a backend whose update operation is not atomic', async () => {
    const values = new Map<string, unknown>()
    const nonAtomicStore = {
      async delete(key: string) {
        values.delete(key)
      },
      async get(key: string) {
        return (values.get(key) ?? null) as never
      },
      async put(key: string, value: unknown) {
        values.set(key, value)
      },
      async update(key: string, updater: (current: unknown) => any) {
        const current = values.get(key) ?? null
        await Promise.resolve()
        const action = updater(current)
        if (action.op === 'set') values.set(key, action.value)
        if (action.op === 'delete') values.delete(key)
        return action.result
      },
    } as unknown as ChargeStore

    await expect(replayStoreConformance(() => nonAtomicStore)).rejects.toMatchObject({
      check: 'concurrent-reservation',
    } satisfies Partial<ReplayStoreConformanceError>)
  })
})
