/**
 * Shared `/supported` cache for b402 server integrations.
 *
 * Facilitator signer/proxy configuration can rotate. A permanent process
 * cache makes the SDK depend on a restart to observe that rotation; no cache
 * creates a remote dependency on every paid request. This bounded TTL cache
 * keeps one parsed snapshot, coalesces concurrent refreshes, and exposes
 * explicit invalidation for operator- or error-triggered refreshes.
 */

import { parseSupportedResponse } from '../Response.js'
import type { SupportedResponse } from '../Types.js'

export const DEFAULT_B402_SUPPORTED_TTL_MS = 5 * 60 * 1_000

export interface B402SupportedClient {
  supported(): Promise<SupportedResponse>
}

export interface B402SupportedCacheOptions {
  /** Cache lifetime; defaults to five minutes. */
  readonly ttlMs?: number
}

export class B402SupportedCache {
  readonly #client: B402SupportedClient
  readonly #ttlMs: number
  #cached: { readonly value: SupportedResponse; readonly expiresAt: number } | undefined
  #inflight: Promise<SupportedResponse> | undefined
  #generation = 0

  constructor(client: B402SupportedClient, options: B402SupportedCacheOptions = {}) {
    const ttlMs = options.ttlMs ?? DEFAULT_B402_SUPPORTED_TTL_MS
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error(`B402SupportedCache: ttlMs must be a positive safe integer (got ${ttlMs})`)
    }
    this.#client = client
    this.#ttlMs = ttlMs
  }

  get(): Promise<SupportedResponse> {
    const cached = this.#cached
    if (cached && Date.now() < cached.expiresAt) return Promise.resolve(cached.value)
    if (this.#inflight) return this.#inflight

    const generation = this.#generation
    const refresh = this.#client
      .supported()
      .then(parseSupportedResponse)
      .then((value) => {
        // `invalidate()` during a slow refresh means the returned value may be
        // used by that caller but must not repopulate the now-invalid cache.
        if (generation === this.#generation) {
          this.#cached = { value, expiresAt: Date.now() + this.#ttlMs }
        }
        return value
      })
      .finally(() => {
        if (this.#inflight === refresh) this.#inflight = undefined
      })
    this.#inflight = refresh
    return refresh
  }

  invalidate(): void {
    this.#generation += 1
    this.#cached = undefined
    this.#inflight = undefined
  }
}
