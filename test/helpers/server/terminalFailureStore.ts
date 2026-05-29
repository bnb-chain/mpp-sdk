/**
 * Test seam — a `ChargeStore` wrapper that fails on a specific `update`
 * shape to simulate a Redis/Postgres transient outage at the terminal
 * commit point of a verifier.
 *
 * Background: every verifier flips `terminalPhase = true` once
 * on-chain state commits the credential's fate; the safety-net catch
 * then refuses to `release()` the slot if a terminal store-write
 * (`markConsumed` or post-success `markRejected`) throws. The earlier
 * regression test for that invariant lived inline in `Hash.test.ts` with
 * a `(current: unknown) => unknown` updater signature — which works at
 * runtime but breaks `tsgo --noEmit -p tsconfig.test.json`.
 *
 * This module shares one correctly-typed helper across all four verifier
 * tests so the regression test for each gets the same shape + the same
 * type guarantees.
 *
 * Implementation: rather than `Proxy`-wrap a real `Store.memory()` (Proxy
 * can't preserve `update<result>`'s generic through TypeScript's type
 * system), we forward `get` directly to an inner Store.memory() and
 * implement `update` ourselves with the same semantics — probe the
 * updater's output once (pure-function contract per mppx Store.Update),
 * fail if the predicate matches, otherwise delegate. This keeps every
 * surface fully typed against `ChargeStore` with no `as unknown`
 * gymnastics at the call site.
 */

import { Store } from 'mppx'

import type { ChargeStore, ReplaySlotState, ReplaySlotValue } from '../../../src/server/Replay.js'

/** Loose Change shape for the failOn predicate — extracted from the
 *  ChargeStore.update signature to stay in sync with mppx future changes. */
type AnyChange = ReturnType<Parameters<ChargeStore['update']>[1]>

export interface TerminalFailureStoreOptions {
  /**
   * Predicate that decides whether a given proposed Change should
   * trigger the simulated outage. Most callers will check
   * `(c) => c.op === 'set' && c.value?.state === <target>` to target
   * a specific terminal state-write. The `failOnState` helper below
   * covers the common case.
   */
  readonly failOn: (probe: AnyChange) => boolean
  /** Error message thrown by the targeted `update` call. */
  readonly message?: string
}

/**
 * Build a ChargeStore where `update` calls whose updater output matches
 * `failOn` throw, while all other store operations behave normally.
 *
 * Probes the updater by invoking it with `null` (the "no current slot"
 * case) WITHOUT mutating the store — the updater MUST be a pure function
 * per mppx's `Store.Update` contract, so this is safe.
 */
export function terminalFailureStore(opts: TerminalFailureStoreOptions): ChargeStore {
  const inner = Store.memory() as unknown as ChargeStore
  const message = opts.message ?? 'simulated terminal-phase backend outage'

  // Implement the ChargeStore interface directly. Forward every base
  // StoreAction to the inner Store.memory() except `update`, which gets
  // the failure-injection wrapper. `update` preserves the `<result>`
  // generic by forwarding to the inner store on the happy path —
  // synchronous `throw` flows out via the wrapper's Promise rejection.
  return {
    get: inner.get.bind(inner),
    put: inner.put.bind(inner),
    delete: inner.delete.bind(inner),
    update: ((key, fn) => {
      // Pure-function probe to classify the intent without mutating.
      const probe = fn(null)
      if (opts.failOn(probe)) {
        throw new Error(message)
      }
      return inner.update(key, fn)
    }) as ChargeStore['update'],
  }
}

/**
 * Convenience: target a terminal state-write by `state` value.
 * Useful shorthand for `failOn: (c) => c.op === 'set' && c.value?.state === state`.
 *
 * `'consumed'` targets `markConsumed`; `'rejected'` targets `markRejected`
 * (which is terminal only in post-on-chain-success paths — the verifier
 * tests use this to simulate "Redis down right when we tried to record
 * the post-success log-mismatch").
 */
export function failOnState(state: ReplaySlotState): (probe: AnyChange) => boolean {
  return (probe) => {
    if (probe.op !== 'set') return false
    // Narrow Change.value (typed as ReplaySlotValue) to read .state safely.
    return (probe.value as ReplaySlotValue).state === state
  }
}
