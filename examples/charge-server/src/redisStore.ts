/**
 * Production replay store backed by Redis — a reference for charge-server.
 *
 * The example boots with `Store.memory()` (in-process only). That is fine for
 * dev, but draft §9 requires a DURABLE, ATOMIC store in production: the replay
 * store is the double-spend guard, and a process restart / multi-instance
 * deployment must not lose or fork its state.
 *
 * mppx's `Store.redis()` JSON-wraps `get` / `set` / `del`, but it does NOT
 * synthesize atomicity — a correct compare-and-swap (`update`) is the caller's
 * responsibility, because a safe CAS needs more than get+set (a bare `get`
 * then unconditional `set` is the TOCTOU double-spend window draft §9.3
 * forbids).
 *
 * We provide `update` with an atomic **Lua compare-and-set** (`EVAL`):
 *   1. read the current value,
 *   2. run the updater in JS to decide the next op,
 *   3. apply it server-side ONLY IF the stored value is still what we read.
 * If another client changed the key in between, the script writes nothing and
 * returns 0, and we retry. EVAL runs atomically inside Redis, so — unlike
 * `WATCH`/`MULTI`, whose watch state is *connection-scoped* — concurrent
 * `update()` calls sharing one connection don't corrupt each other.
 *
 * Usage (swap the memory default in handler.ts):
 *
 *   import Redis from 'ioredis'
 *   import { createRedisChargeStore } from './redisStore.js'
 *
 *   const store = createRedisChargeStore(new Redis(process.env.REDIS_URL!))
 *   await chargeAsync({ chain: 'bsc-testnet', token: 'TEST_USDT', recipient, store, ... })
 *
 * The `RedisLike` surface is the ioredis / Valkey `eval(script, numKeys, ...)`
 * shape. node-redis v4's `eval(script, { keys, arguments })` differs — wrap it
 * in a thin adapter. (Upstash/Vercel KV and Cloudflare KV have their own mppx
 * helpers — `Store.upstash` / `Store.cloudflare` — use those there.)
 */

import { type ChargeStore } from '@bnb-chain/mpp/server'
import { Store } from 'mppx'

/** Minimal ioredis / Valkey-compatible surface this store needs. */
export interface RedisLike {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<unknown>
  del(key: string): Promise<unknown>
  /** ioredis/Valkey shape: `eval(script, numKeys, ...keysThenArgs)`. */
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>
}

/** Bound on CAS retries before surfacing persistent write contention. */
const MAX_CAS_RETRIES = 50

/**
 * Atomic compare-and-set. KEYS[1] = key; ARGV = [present, expectedOld, op,
 * newValue]. Writes only if the current value still equals what the caller
 * read (`present`/`expectedOld`); returns 1 on apply, 0 on a lost race.
 */
const CAS_LUA = `
local cur = redis.call('GET', KEYS[1])
if ARGV[1] == '1' then
  if cur ~= ARGV[2] then return 0 end
else
  if cur then return 0 end
end
if ARGV[3] == 'set' then
  redis.call('SET', KEYS[1], ARGV[4])
else
  redis.call('DEL', KEYS[1])
end
return 1`

export function createRedisChargeStore(redis: RedisLike): ChargeStore {
  // Store.redis returns AtomicStore<Record<string, unknown>>; the SDK wants
  // AtomicStore<ReplayItemMap>. The store is value-agnostic at runtime (it
  // JSON-roundtrips), so narrowing the value type with a cast is sound.
  return Store.redis({
    get: (key) => redis.get(key),
    set: (key, value) => redis.set(key, value),
    del: (key) => redis.del(key),
    async update<result>(
      key: string,
      fn: (current: string | null) => Store.Change<string, result>,
    ): Promise<result> {
      for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
        const current = await redis.get(key)
        const change = fn(current)
        if (change.op === 'noop') return change.result
        const present = current === null ? '0' : '1'
        const expectedOld = current ?? ''
        const op = change.op === 'set' ? 'set' : 'del'
        const newValue = change.op === 'set' ? change.value : ''
        // 1 ⇒ applied; 0 ⇒ a concurrent writer changed the key ⇒ retry.
        const applied = await redis.eval(CAS_LUA, 1, key, present, expectedOld, op, newValue)
        if (Number(applied) === 1) return change.result
      }
      throw new Error(
        `createRedisChargeStore: compare-and-set on '${key}' did not converge after ` +
          `${MAX_CAS_RETRIES} retries (persistent write contention).`,
      )
    },
    // No keyPrefix option: the SDK already namespaces every replay key as
    // `bnb-mpp:evm:charge:…` (see src/server/Replay.ts). Pass `{ keyPrefix }`
    // as a second arg only for multi-tenant isolation on a shared Redis.
  }) as ChargeStore
}
