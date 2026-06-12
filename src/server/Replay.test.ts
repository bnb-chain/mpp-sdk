/**
 * Replay store invariants (spec §9).
 *
 *   - reserve is atomic CAS — two parallel callers cannot both succeed
 *   - markConsumed / markRejected are permanent — release/reserve cannot
 *     resurrect the slot
 *   - terminal states are write-once (CAS-enforced) — after a
 *     stale-inflight reclaim race, a late markRejected cannot downgrade
 *     a consumed slot (and vice versa)
 *   - release only works on `inflight` (consumed / rejected are permanent)
 *   - stale `inflight` slots (ts older than inflightTtlMs, default 10min)
 *     are reclaimed by reserve; consumed / rejected are NEVER reclaimed
 *   - keys lowercase all address inputs (EIP-55 insensitivity)
 *   - keys carry the full discriminators required to prevent cross-token /
 *     cross-deployment collisions
 */

import { Store } from 'mppx'
import { describe, expect, test } from 'vitest'

import {
  type ChargeStore,
  type ReplayKey,
  type ReplaySlotValue,
  authKey,
  getReplaySlot,
  markConsumed,
  markRejected,
  permit2Key,
  release,
  ReplayStoreUnavailableError,
  reserve,
  txHashKey,
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
    const key = txHashKey(1, TX_HASH)
    expect(await reserve(store, key)).toBe(true)
    const slot = await store.get(key)
    expect(slot?.state).toBe('inflight')
    expect(slot?.ts).toBeTypeOf('number')
  })

  test('second reserve returns false while inflight', async () => {
    const store = freshStore()
    const key = txHashKey(1, TX_HASH)
    expect(await reserve(store, key)).toBe(true)
    expect(await reserve(store, key)).toBe(false)
  })

  test('parallel reserves: exactly one returns true', async () => {
    const store = freshStore()
    const key = txHashKey(1, TX_HASH)
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
    const key = txHashKey(1, TX_HASH)
    await reserve(store, key)
    await markConsumed(store, key)
    expect((await store.get(key))?.state).toBe('consumed')
    expect(await reserve(store, key)).toBe(false)
  })

  test('release after consumed is a noop (slot stays consumed)', async () => {
    const store = freshStore()
    const key = txHashKey(1, TX_HASH)
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
    const key = txHashKey(1, TX_HASH)
    await reserve(store, key)
    await markRejected(store, key, 'on-chain reverted')
    const slot = await store.get(key)
    expect(slot?.state).toBe('rejected')
    expect(slot?.reason).toBe('on-chain reverted')
  })

  test('reserve after rejected returns false (slot stays rejected)', async () => {
    const store = freshStore()
    const key = txHashKey(1, TX_HASH)
    await reserve(store, key)
    await markRejected(store, key, 'Transfer log mismatch')
    expect(await reserve(store, key)).toBe(false)
    expect((await store.get(key))?.state).toBe('rejected')
  })

  test('release after rejected is a noop (slot stays rejected)', async () => {
    const store = freshStore()
    const key = txHashKey(1, TX_HASH)
    await reserve(store, key)
    await markRejected(store, key, 'sig invalid')
    await release(store, key)
    expect((await store.get(key))?.state).toBe('rejected')
  })

  test('consumed ≠ rejected (state strings are distinct)', async () => {
    const a = freshStore()
    const b = freshStore()
    await reserve(a, txHashKey(1, TX_HASH))
    await reserve(b, txHashKey(1, TX_HASH))
    await markConsumed(a, txHashKey(1, TX_HASH))
    await markRejected(b, txHashKey(1, TX_HASH), 'reverted')
    expect((await a.get(txHashKey(1, TX_HASH)))?.state).toBe('consumed')
    expect((await b.get(txHashKey(1, TX_HASH)))?.state).toBe('rejected')
  })
})

/* -------------------------------------------------------------------------- */
/*  Terminal write-once (CAS-enforced)                                        */
/* -------------------------------------------------------------------------- */

describe('terminal states are write-once (CAS-enforced)', () => {
  test('markRejected on a consumed slot is a noop (no downgrade)', async () => {
    const store = freshStore()
    const key = txHashKey(1, TX_HASH)
    await reserve(store, key)
    await markConsumed(store, key)
    // Stale-inflight reclaim race: the flow that lost the race may still
    // attempt its own terminal write. It must not downgrade the settled
    // payment to rejected — that would erase the consumed audit state.
    await markRejected(store, key, 'late loser write')
    const slot = await store.get(key)
    expect(slot?.state).toBe('consumed')
    expect(slot?.reason).toBeUndefined()
  })

  test('markConsumed on a rejected slot is a noop (reason preserved)', async () => {
    const store = freshStore()
    const key = txHashKey(1, TX_HASH)
    await reserve(store, key)
    await markRejected(store, key, 'on-chain reverted')
    await markConsumed(store, key)
    const slot = await store.get(key)
    expect(slot?.state).toBe('rejected')
    expect(slot?.reason).toBe('on-chain reverted')
  })

  test('re-marking consumed is a harmless noop (ts not refreshed)', async () => {
    const store = freshStore()
    const key = txHashKey(1, TX_HASH)
    // Write directly with a distinct old ts so a refresh would be visible.
    const oldTs = Date.now() - 60_000
    await store.update(key, () => ({
      op: 'set',
      value: { state: 'consumed', ts: oldTs },
      result: true as const,
    }))
    await markConsumed(store, key)
    const slot = await store.get(key)
    expect(slot?.state).toBe('consumed')
    expect(slot?.ts).toBe(oldTs)
  })

  test('re-marking rejected keeps the FIRST reason (no overwrite)', async () => {
    const store = freshStore()
    const key = txHashKey(1, TX_HASH)
    await reserve(store, key)
    await markRejected(store, key, 'first reason')
    await markRejected(store, key, 'second reason')
    const slot = await store.get(key)
    expect(slot?.state).toBe('rejected')
    expect(slot?.reason).toBe('first reason')
  })

  test('inflight slots are still writable (normal terminal transition)', async () => {
    const store = freshStore()
    const key = txHashKey(1, TX_HASH)
    await reserve(store, key)
    await markConsumed(store, key)
    expect((await store.get(key))?.state).toBe('consumed')
  })
})

/* -------------------------------------------------------------------------- */
/*  release on inflight                                                       */
/* -------------------------------------------------------------------------- */

describe('release', () => {
  test('inflight → free (entry deleted)', async () => {
    const store = freshStore()
    const key = txHashKey(1, TX_HASH)
    await reserve(store, key)
    await release(store, key)
    expect(await store.get(key)).toBeNull()
  })

  test('released slot can be re-reserved', async () => {
    const store = freshStore()
    const key = txHashKey(1, TX_HASH)
    await reserve(store, key)
    await release(store, key)
    expect(await reserve(store, key)).toBe(true)
  })

  test('release on missing slot is noop', async () => {
    const store = freshStore()
    const key = txHashKey(1, TX_HASH)
    await release(store, key)
    expect(await store.get(key)).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/*  Stale-inflight reclaim                                                    */
/* -------------------------------------------------------------------------- */

describe('stale-inflight reclaim', () => {
  /**
   * Write a slot directly (bypassing reserve) so each test fully controls
   * the slot's `ts` age — the reclaim decision is `Date.now() - ts >= ttl`.
   */
  async function writeSlot(
    store: ChargeStore,
    key: ReplayKey,
    value: ReplaySlotValue,
  ): Promise<void> {
    await store.update(key, () => ({ op: 'set', value, result: true as const }))
  }

  test('fresh inflight slot is NOT reclaimable (reserve returns false)', async () => {
    const store = freshStore()
    const key = txHashKey(1, TX_HASH)
    const freshTs = Date.now()
    await writeSlot(store, key, { state: 'inflight', ts: freshTs })

    expect(await reserve(store, key)).toBe(false)

    // Slot untouched — the losing reserve must not refresh a live slot's ts
    // (that would let serial losers keep a crashed verify pinned forever).
    const slot = await store.get(key)
    expect(slot?.state).toBe('inflight')
    expect(slot?.ts).toBe(freshTs)
  })

  test('inflight slot older than the default TTL IS reclaimed (ts refreshed)', async () => {
    const store = freshStore()
    const key = txHashKey(1, TX_HASH)
    // 11 minutes in the past — comfortably beyond the 10min default TTL.
    const staleTs = Date.now() - 11 * 60 * 1000
    await writeSlot(store, key, { state: 'inflight', ts: staleTs })

    expect(await reserve(store, key)).toBe(true)

    // The reclaiming reserve re-enters verification: the slot is inflight
    // again with a REFRESHED ts (a second concurrent retry must now wait
    // out a full TTL, not instantly reclaim the same stale timestamp).
    const slot = await store.get(key)
    expect(slot?.state).toBe('inflight')
    expect(slot?.ts).toBeGreaterThan(staleTs)
  })

  test('reserve honors a custom inflightTtlMs', async () => {
    const store = freshStore()
    const key = txHashKey(1, TX_HASH)
    // 5 seconds old: fresh under the 10min default, stale under a 1s TTL.
    const ts = Date.now() - 5_000
    await writeSlot(store, key, { state: 'inflight', ts })

    // Default TTL: not stale → not reclaimable.
    expect(await reserve(store, key)).toBe(false)
    // Custom 1s TTL: stale → reclaimed.
    expect(await reserve(store, key, { inflightTtlMs: 1000 })).toBe(true)
    expect((await store.get(key))?.ts).toBeGreaterThan(ts)
  })

  test('consumed slots are NEVER reclaimed regardless of age', async () => {
    const store = freshStore()
    const key = txHashKey(1, TX_HASH)
    // A year in the past — far beyond any plausible TTL.
    const ancientTs = Date.now() - 365 * 24 * 60 * 60 * 1000
    await writeSlot(store, key, { state: 'consumed', ts: ancientTs })

    expect(await reserve(store, key)).toBe(false)
    // Even an absurdly aggressive TTL must not resurrect a settled payment.
    expect(await reserve(store, key, { inflightTtlMs: 1 })).toBe(false)

    const slot = await store.get(key)
    expect(slot?.state).toBe('consumed')
    expect(slot?.ts).toBe(ancientTs)
  })

  test('rejected slots are NEVER reclaimed regardless of age', async () => {
    const store = freshStore()
    const key = txHashKey(1, TX_HASH)
    const ancientTs = Date.now() - 365 * 24 * 60 * 60 * 1000
    await writeSlot(store, key, {
      state: 'rejected',
      ts: ancientTs,
      reason: 'on-chain reverted',
    })

    expect(await reserve(store, key)).toBe(false)
    expect(await reserve(store, key, { inflightTtlMs: 1 })).toBe(false)

    const slot = await store.get(key)
    expect(slot?.state).toBe('rejected')
    expect(slot?.reason).toBe('on-chain reverted')
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

  test('txHashKey lowercases txHash', () => {
    expect(txHashKey(1, TX_HASH.toUpperCase() as `0x${string}`)).toBe(txHashKey(1, TX_HASH))
  })

  test('permit2Key canonicalizes nonce via BigInt (leading zeros collapse)', () => {
    // "1" and "01" hash to the identical EIP-712 message (BigInt(nonce)) —
    // they MUST map to the same replay slot or a concurrent re-encoding
    // bypasses the inflight guard and double-broadcasts the settlement.
    expect(permit2Key(1, PERMIT2, SIGNER, '01')).toBe(permit2Key(1, PERMIT2, SIGNER, '1'))
    expect(permit2Key(1, PERMIT2, SIGNER, '0042')).toBe(permit2Key(1, PERMIT2, SIGNER, '42'))
    expect(permit2Key(1, PERMIT2, SIGNER, '10')).not.toBe(permit2Key(1, PERMIT2, SIGNER, '1'))
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

  test('txHashKey differs across chainId', () => {
    expect(txHashKey(1, TX_HASH)).not.toBe(txHashKey(56, TX_HASH))
  })

  test('txHashKey carries NO credential-type discriminator (spec §8 shared token)', () => {
    // Both `transaction` and `hash` credentials use the tx hash as their
    // replay token (spec §8) — one transfer must settle at most one charge
    // regardless of which credential type presents it. The key is therefore
    // scoped by (chainId, txHash) only.
    expect(txHashKey(1, TX_HASH)).toBe(`bnb-mpp:evm:charge:txhash:1:${TX_HASH}`)
  })

  test('replay namespace prefix is bnb-mpp', () => {
    expect(txHashKey(1, TX_HASH).startsWith('bnb-mpp:evm:charge:')).toBe(true)
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

  const key = txHashKey(1, TX_HASH)

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
