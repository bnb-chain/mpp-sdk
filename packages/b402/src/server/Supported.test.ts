/** B402SupportedCache — TTL, single-flight, and explicit invalidation. */

import { afterEach, describe, expect, test, vi } from 'vitest'

import type { SupportedResponse } from '../Types.js'
import { B402SupportedCache } from './Supported.js'

function response(name: string): SupportedResponse {
  return {
    kinds: [
      {
        x402Version: 2,
        scheme: 'exact',
        network: 'eip155:56',
        extra: {
          name,
          version: '1',
          assetTransferMethod: 'eip3009',
          signerAddress: '0x1111111111111111111111111111111111111111',
        },
      },
    ],
    extensions: [],
    signers: {},
  }
}

describe('B402SupportedCache', () => {
  afterEach(() => vi.useRealTimers())

  test('coalesces concurrent misses and caches the parsed response until TTL expiry', async () => {
    vi.useFakeTimers()
    const calls: number[] = []
    const client = {
      async supported(): Promise<SupportedResponse> {
        calls.push(calls.length + 1)
        return response(`token-${calls.length}`)
      },
    }
    const cache = new B402SupportedCache(client, { ttlMs: 1_000 })

    const [a, b] = await Promise.all([cache.get(), cache.get()])
    expect(a).toBe(b)
    expect(calls).toHaveLength(1)

    vi.advanceTimersByTime(999)
    expect(await cache.get()).toBe(a)
    expect(calls).toHaveLength(1)

    vi.advanceTimersByTime(1)
    const refreshed = await cache.get()
    expect(refreshed).not.toBe(a)
    expect(calls).toHaveLength(2)
  })

  test('invalidate forces the next read to refresh before TTL expiry', async () => {
    let calls = 0
    const client = {
      async supported(): Promise<SupportedResponse> {
        calls += 1
        return response(`token-${calls}`)
      },
    }
    const cache = new B402SupportedCache(client, { ttlMs: 60_000 })
    const first = await cache.get()
    cache.invalidate()
    const second = await cache.get()
    expect(second).not.toBe(first)
    expect(calls).toBe(2)
  })

  test('rejects invalid cache configuration', () => {
    const client = { supported: async () => response('token') }
    expect(() => new B402SupportedCache(client, { ttlMs: 0 })).toThrow(/positive safe integer/)
  })
})
