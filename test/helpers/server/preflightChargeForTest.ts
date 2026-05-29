/**
 * Test-only seam for `preflightCharge` (spec §14.10).
 *
 * Production `preflightCharge` accepts no mocking parameters — `package.json`
 * `exports` deliberately does NOT surface this module. Tests import it via
 * its full source path to inject:
 *
 *   - `mockedIsContractDeployed` so unit tests can exercise the Permit2
 *     deployment-probe branches without hitting RPC.
 *
 * Add additional mock hooks here as future test seams are needed; never
 * lift them into production `preflightCharge`.
 */

import type { PublicClient } from 'viem'

import {
  type _PreflightInternalHooks,
  type ResolvedChargeParams,
  type ServerParameters,
  preflightChargeInternal,
} from '../../../src/server/Charge.js'

export interface PreflightForTestMocks {
  /** Stub for the Permit2 deployment probe. Default in tests: `() => true`. */
  readonly mockedIsContractDeployed?: (address: `0x${string}`) => boolean | Promise<boolean>
  /**
   * Override the publicClient used downstream by verifiers. Verifiers use this
   * to inject a stub `getTransactionReceipt` / `getBlockNumber` so tests
   * stay offline and deterministic.
   */
  readonly publicClient?: PublicClient
  /**
   * Bypass preflight's sentinel-zero-address rejection. Live-test scaffolds
   * (test/live/*.live.test.ts) use this to point at `bsc-testnet` /
   * `opbnb-testnet` `TEST_USDT` while the curated matrix still carries
   * the placeholder zero address. Unit / interop tests MUST NOT set this.
   */
  readonly allowSentinelTokenAddress?: boolean
}

export async function preflightChargeForTest(
  params: ServerParameters,
  mocks: PreflightForTestMocks = {},
): Promise<ResolvedChargeParams> {
  const hooks: _PreflightInternalHooks = {
    ...(mocks.mockedIsContractDeployed && {
      isContractDeployed: async (_publicClient, address) =>
        mocks.mockedIsContractDeployed!(address),
    }),
    ...(mocks.publicClient && { publicClientOverride: mocks.publicClient }),
    ...(mocks.allowSentinelTokenAddress && { allowSentinelTokenAddress: true }),
  }
  return preflightChargeInternal(params, hooks)
}
