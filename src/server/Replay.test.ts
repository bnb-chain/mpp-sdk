/**
 * Replay store invariants (spec §9).
 *
 *   - reserve is atomic CAS — two parallel callers cannot both succeed
 *   - markConsumed / markRejected are permanent — release/reserve cannot
 *     resurrect the slot
 *   - release only works on `inflight` (consumed / rejected are permanent)
 *   - keys lowercase all address inputs (EIP-55 insensitivity)
 *   - keys carry the full discriminators required to prevent cross-token /
 *     cross-deployment collisions
 */

import { Store } from 'mppx'
import { describe, expect, test } from 'vitest'

import {
  type ChargeStore,
  authKey,
  getReplaySlot,
  hashKey,
  markConsumed,
  markRejected,
  permit2Key,
  release,
  ReplayStoreUnavailableError,
  reserve,
  txKey,
} from './Replay.js'

const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'
const PERMIT2_FORK = '0x000000000000000000000000000000000000aaaa'
const SIGNER = '0x1111111111111111111111111111111111111111'
const TOKEN = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const TX_HASH = '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
const NONCE32 = '0x0000000000000000000000000000000000000000000000000000000000000042'

const freshStore = (): ChargeStore => Store.memory() as ChargeStore

/* -------------------------------------------------------------------------- */
/*  Atomic CAS                                                                */
/* -------------------------------------------------------------------------- */

describe('reserve (atomic CAS)', () => {
  test('first reserve returns true; slot now inflight', async () => {
    const store = freshStore()
    const key = txKey(1, TX_HASH)
    expect(await reserve(store, key)).toBe(true)
    const slot = await store.get(key)
    expect(slot?.state).toBe('inflight')
    expect(slot?.ts).toBeTypeOf('number')
  })

  test('second reserve returns false while inflight', async () => {
    const store = freshStore()
    const key = txKey(1, TX_HASH)
    expect(await reserve(store, key)).toBe(true)
    expect(await reserve(store, key)).toBe(false)
  })

  test('parallel reserves: exactly one returns true', async () => {
    const store = freshStore()
    const key = txKey(1, TX_HASH)
    const results = await Promise.all(Array.from({ length: 20 }, () => reserve(store, key)))
    expect(results.filter((r) => r === true)).toHaveLength(1)
  })
})

/* -------------------------------------------------------------------------- */
/*  Permanence: consumed                                                      */
/* -------------------------------------------------------------------------- */

describe('markConsumed (permanent)', () => {
  test('inflight → consumed; reserve still returns false', async () => {
    const store = freshStore()
    const key = txKey(1, TX_HASH)
    await reserve(store, key)
    await markConsumed(store, key)
    expect((await store.get(key))?.state).toBe('consumed')
    expect(await reserve(store, key)).toBe(false)
  })

  test('release after consumed is a noop (slot stays consumed)', async () => {
    const store = freshStore()
    const key = txKey(1, TX_HASH)
    await reserve(store, key)
    await markConsumed(store, key)
    await release(store, key)
    expect((await store.get(key))?.state).toBe('consumed')
  })
})

/* -------------------------------------------------------------------------- */
/*  Permanence: rejected                                                      */
/* -------------------------------------------------------------------------- */

describe('markRejected (permanent + reason)', () => {
  test('inflight → rejected; reason is preserved', async () => {
    const store = freshStore()
    const key = txKey(1, TX_HASH)
    await reserve(store, key)
    await markRejected(store, key, 'on-chain reverted')
    const slot = await store.get(key)
    expect(slot?.state).toBe('rejected')
    expect(slot?.reason).toBe('on-chain reverted')
  })

  test('reserve after rejected returns false (slot stays rejected)', async () => {
    const store = freshStore()
    const key = txKey(1, TX_HASH)
    await reserve(store, key)
    await markRejected(store, key, 'Transfer log mismatch')
    expect(await reserve(store, key)).toBe(false)
    expect((await store.get(key))?.state).toBe('rejected')
  })

  test('release after rejected is a noop (slot stays rejected)', async () => {
    const store = freshStore()
    const key = txKey(1, TX_HASH)
    await reserve(store, key)
    await markRejected(store, key, 'sig invalid')
    await release(store, key)
    expect((await store.get(key))?.state).toBe('rejected')
  })

  test('consumed ≠ rejected (state strings are distinct)', async () => {
    const a = freshStore()
    const b = freshStore()
    await reserve(a, txKey(1, TX_HASH))
    await reserve(b, txKey(1, TX_HASH))
    await markConsumed(a, txKey(1, TX_HASH))
    await markRejected(b, txKey(1, TX_HASH), 'reverted')
    expect((await a.get(txKey(1, TX_HASH)))?.state).toBe('consumed')
    expect((await b.get(txKey(1, TX_HASH)))?.state).toBe('rejected')
  })
})

/* -------------------------------------------------------------------------- */
/*  release on inflight                                                       */
/* -------------------------------------------------------------------------- */

describe('release', () => {
  test('inflight → free (entry deleted)', async () => {
    const store = freshStore()
    const key = txKey(1, TX_HASH)
    await reserve(store, key)
    await release(store, key)
    expect(await store.get(key)).toBeNull()
  })

  test('released slot can be re-reserved', async () => {
    const store = freshStore()
    const key = txKey(1, TX_HASH)
    await reserve(store, key)
    await release(store, key)
    expect(await reserve(store, key)).toBe(true)
  })

  test('release on missing slot is noop', async () => {
    const store = freshStore()
    const key = txKey(1, TX_HASH)
    await release(store, key)
    expect(await store.get(key)).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/*  Key factories                                                             */
/* -------------------------------------------------------------------------- */

describe('key factories — lowercase address normalization', () => {
  test('permit2Key lowercases permit2Address + signer', () => {
    const lower = permit2Key(1, PERMIT2, SIGNER, '42')
    const upper = permit2Key(
      1,
      PERMIT2.toUpperCase() as `0x${string}`,
      SIGNER.toUpperCase() as `0x${string}`,
      '42',
    )
    expect(upper).toBe(lower)
  })

  test('authKey lowercases token + from + nonce hex', () => {
    const lower = authKey(1, TOKEN, SIGNER, NONCE32)
    const upper = authKey(
      1,
      TOKEN.toUpperCase() as `0x${string}`,
      SIGNER.toUpperCase() as `0x${string}`,
      NONCE32.toUpperCase() as `0x${string}`,
    )
    expect(upper).toBe(lower)
  })

  test('txKey + hashKey lowercase txHash', () => {
    expect(txKey(1, TX_HASH.toUpperCase() as `0x${string}`)).toBe(txKey(1, TX_HASH))
    expect(hashKey(1, TX_HASH.toUpperCase() as `0x${string}`)).toBe(hashKey(1, TX_HASH))
  })
})

describe('key factories — cross-namespace collision prevention', () => {
  test('permit2Key differs across permit2Address (canonical vs fork)', () => {
    const canonical = permit2Key(1, PERMIT2, SIGNER, '42')
    const fork = permit2Key(1, PERMIT2_FORK, SIGNER, '42')
    expect(canonical).not.toBe(fork)
  })

  test('authKey differs across token (EIP-3009 nonce per-token)', () => {
    const usdc = authKey(1, TOKEN, SIGNER, NONCE32)
    const usdt = authKey(1, '0xdac17f958d2ee523a2206206994597c13d831ec7', SIGNER, NONCE32)
    expect(usdc).not.toBe(usdt)
  })

  test('txKey differs across chainId', () => {
    expect(txKey(1, TX_HASH)).not.toBe(txKey(56, TX_HASH))
  })

  test('credential-type prefixes differ (tx vs hash) even on same (chainId, hash)', () => {
    expect(txKey(1, TX_HASH)).not.toBe(hashKey(1, TX_HASH))
  })

  test('replay namespace prefix is bnb-mpp', () => {
    expect(txKey(1, TX_HASH).startsWith('bnb-mpp:evm:charge:')).toBe(true)
    expect(hashKey(1, TX_HASH).startsWith('bnb-mpp:evm:charge:')).toBe(true)
    expect(authKey(1, TOKEN, SIGNER, NONCE32).startsWith('bnb-mpp:evm:charge:')).toBe(true)
    expect(permit2Key(1, PERMIT2, SIGNER, '42').startsWith('bnb-mpp:evm:charge:')).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/*  Backend-unavailable error normalization                                    */
/* -------------------------------------------------------------------------- */

describe('ReplayStoreUnavailableError', () => {
  /**
   * A store backend whose `.update` always rejects, simulating Redis
   * `EHOSTUNREACH` / Postgres `ECONNREFUSED` / Cloudflare KV throttle.
   * `.get` works (returns null) so we can test that the cleanup path in
   * verifiers tolerates EITHER component independently.
   */
  function brokenStore(causeMsg = 'EHOSTUNREACH: simulated backend down'): ChargeStore {
    return {
      async get() {
        return null
      },
      async update() {
        throw new Error(causeMsg)
      },
    } as unknown as ChargeStore
  }

  const key = txKey(1, TX_HASH)

  test('reserve() wraps backend throw in ReplayStoreUnavailableError', async () => {
    const store = brokenStore()
    await expect(reserve(store, key)).rejects.toThrow(ReplayStoreUnavailableError)
    await expect(reserve(store, key)).rejects.toThrow(/backend unavailable/)
    await expect(reserve(store, key)).rejects.toThrow(/EHOSTUNREACH/)
  })

  test('markConsumed() wraps backend throw', async () => {
    await expect(markConsumed(brokenStore(), key)).rejects.toThrow(ReplayStoreUnavailableError)
  })

  test('markRejected() wraps backend throw', async () => {
    await expect(markRejected(brokenStore(), key, 'test')).rejects.toThrow(
      ReplayStoreUnavailableError,
    )
  })

  test('release() wraps backend throw', async () => {
    await expect(release(brokenStore(), key)).rejects.toThrow(ReplayStoreUnavailableError)
  })

  test('getReplaySlot() wraps backend throw on .get', async () => {
    // brokenStore.get returns null today; make it throw to test get-path
    // normalization. Verifier diagnostic-read branches use getReplaySlot
    // instead of raw store.get specifically so this surfaces as a
    // ReplayStoreUnavailableError they can catch by class.
    const getBrokenStore = {
      async get() {
        throw new Error('EHOSTUNREACH: get path down')
      },
      async update() {
        return false
      },
    } as unknown as ChargeStore
    await expect(getReplaySlot(getBrokenStore, key)).rejects.toThrow(ReplayStoreUnavailableError)
    await expect(getReplaySlot(getBrokenStore, key)).rejects.toThrow(/EHOSTUNREACH: get path/)
    try {
      await getReplaySlot(getBrokenStore, key)
    } catch (err) {
      expect((err as ReplayStoreUnavailableError).op).toBe('get')
    }
  })

  test('getReplaySlot() returns null for genuinely empty slot (happy path)', async () => {
    const store = Store.memory() as unknown as ChargeStore
    expect(await getReplaySlot(store, key)).toBeNull()
  })

  test('preserves the original error as .cause for diagnostics', async () => {
    try {
      await reserve(brokenStore('original-backend-msg'), key)
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ReplayStoreUnavailableError)
      const wrapped = err as ReplayStoreUnavailableError
      expect(wrapped.op).toBe('reserve')
      expect(wrapped.key).toBe(key)
      expect(wrapped.cause).toBeInstanceOf(Error)
      expect((wrapped.cause as Error).message).toBe('original-backend-msg')
    }
  })

  test('does not double-wrap a pre-wrapped error', async () => {
    // If a backend implementation itself throws ReplayStoreUnavailableError
    // (unlikely, but defensive), don't wrap it again into a chain that
    // hides the original `op`/`key` context.
    const preWrapped = new ReplayStoreUnavailableError({
      op: 'reserve',
      key,
      cause: new Error('inner'),
    })
    const store = {
      async update() {
        throw preWrapped
      },
    } as unknown as ChargeStore
    try {
      await reserve(store, key)
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBe(preWrapped) // identity-equal, not a wrapper around it
    }
  })

  test('successful operations are unaffected (happy path passes through normalization)', async () => {
    const store = Store.memory() as unknown as ChargeStore
    expect(await reserve(store, key)).toBe(true)
    await markConsumed(store, key)
    const slot = await store.get(key)
    expect(slot?.state).toBe('consumed')
  })
})
