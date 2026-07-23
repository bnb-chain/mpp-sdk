/**
 * @bnb-chain/mpp/testing — deployment conformance helpers.
 *
 * These helpers are framework-agnostic: call them from Vitest, Jest, Node's
 * test runner, or a deployment smoke test.
 */

export {
  replayStoreConformance,
  ReplayStoreConformanceError,
  type ReplayStoreConformanceOptions,
  type ReplayStoreFactory,
} from './ReplayStoreConformance.js'
