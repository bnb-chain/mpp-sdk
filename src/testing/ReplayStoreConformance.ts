import {
  getReplaySlot,
  markConsumed,
  markRejected,
  release,
  reserve,
  type ChargeStore,
  type ReplayKey,
} from '../server/Replay.js'

export type ReplayStoreFactory = () => ChargeStore | Promise<ChargeStore>

export interface ReplayStoreConformanceOptions {
  /**
   * Run the concurrent-reservation check. Enabled by default. Disable only
   * when a backend's test environment cannot execute concurrent requests.
   */
  readonly concurrent?: boolean
  /**
   * Optional second client connected to the same backing store. When present,
   * the concurrency check alternates reservations across both clients so a
   * deployment can verify cross-connection atomicity, not merely one object.
   */
  readonly createPeerStore?: ReplayStoreFactory
}

export class ReplayStoreConformanceError extends Error {
  override readonly name = 'ReplayStoreConformanceError'
  readonly check: string

  constructor(check: string, detail: string) {
    super(`Replay store conformance failed [${check}]: ${detail}`)
    this.check = check
  }
}

let runSequence = 0

/**
 * Exercises the replay-store state machine against a deployment backend.
 *
 * This validates observable CAS behavior: exclusive reservation, fencing,
 * terminal-state immutability, stale-inflight reclaim, and optional
 * cross-client concurrency. It cannot prove operational properties such as
 * persistence across process restarts, geographic durability, encryption, or
 * the absence of an external TTL. Run it against an isolated test namespace
 * because terminal slots are intentionally permanent and cannot be cleaned up
 * through the public replay Interface.
 */
export async function replayStoreConformance(
  createStore: ReplayStoreFactory,
  options: ReplayStoreConformanceOptions = {},
): Promise<void> {
  const prefix = `conformance-${Date.now()}-${++runSequence}`
  const key = (suffix: string): ReplayKey => `${prefix}:evm:charge:${suffix}`
  const store = await createStore()

  const releasableKey = key('releasable')
  const owner = await reserve(store, releasableKey)
  assert(owner !== null, 'exclusive-reservation', 'first reserve returned null')
  assert(
    (await reserve(store, releasableKey)) === null,
    'exclusive-reservation',
    'second reserve acquired an occupied slot',
  )
  await release(store, releasableKey, 'not-the-owner')
  assert(
    (await getReplaySlot(store, releasableKey))?.token === owner,
    'fencing-token',
    'a non-owner release changed the live reservation',
  )
  await release(store, releasableKey, owner)
  assert(
    (await getReplaySlot(store, releasableKey)) === null,
    'owned-release',
    'the reservation owner could not release an inflight slot',
  )

  const consumedKey = key('consumed')
  const consumedOwner = await reserve(store, consumedKey)
  assert(consumedOwner !== null, 'consumed-terminal', 'could not reserve consumed test slot')
  await markConsumed(store, consumedKey)
  await markRejected(store, consumedKey, 'must not replace consumed')
  await release(store, consumedKey, consumedOwner)
  assert(
    (await getReplaySlot(store, consumedKey))?.state === 'consumed',
    'consumed-terminal',
    'consumed state was overwritten or released',
  )

  const rejectedKey = key('rejected')
  const rejectedOwner = await reserve(store, rejectedKey)
  assert(rejectedOwner !== null, 'rejected-terminal', 'could not reserve rejected test slot')
  await markRejected(store, rejectedKey, 'known-bad')
  await markConsumed(store, rejectedKey)
  await release(store, rejectedKey, rejectedOwner)
  const rejected = await getReplaySlot(store, rejectedKey)
  assert(
    rejected?.state === 'rejected' && rejected.reason === 'known-bad',
    'rejected-terminal',
    'rejected state or its first reason was overwritten',
  )

  const staleKey = key('stale-reclaim')
  const staleToken = 'stale-owner'
  await store.update(staleKey, () => ({
    op: 'set',
    result: undefined,
    value: { state: 'inflight', token: staleToken, ts: 0 },
  }))
  const successor = await reserve(store, staleKey, { inflightTtlMs: 1 })
  assert(
    successor !== null && successor !== staleToken,
    'stale-reclaim',
    'stale inflight slot was not reclaimed with a fresh token',
  )
  await release(store, staleKey, staleToken)
  assert(
    (await getReplaySlot(store, staleKey))?.token === successor,
    'stale-fencing',
    'the stale owner released its successor reservation',
  )
  if (successor !== null) await release(store, staleKey, successor)

  if (options.concurrent ?? true) {
    const peer = options.createPeerStore ? await options.createPeerStore() : store
    const concurrentKey = key('concurrent')
    const attempts = Array.from({ length: 16 }, (_, index) =>
      reserve(index % 2 === 0 ? store : peer, concurrentKey),
    )
    const winners = (await Promise.all(attempts)).filter(
      (candidate): candidate is string => candidate !== null,
    )
    assert(
      winners.length === 1,
      'concurrent-reservation',
      `expected exactly one winner, received ${winners.length}`,
    )
    if (winners[0]) await release(store, concurrentKey, winners[0])
  }
}

function assert(condition: boolean, check: string, detail: string): asserts condition {
  if (!condition) throw new ReplayStoreConformanceError(check, detail)
}
