/**
 * @bnb-chain/mpp/server — server-side runtime.
 *
 * Composes with mppx's Mppx.create() entry. Typical use:
 *
 *   import { Mppx } from 'mppx/server'
 *   import { chargeAsync } from '@bnb-chain/mpp/server'
 *
 *   const handler = Mppx.create({
 *     methods: [await chargeAsync({ chain, token, recipient, challengeBinding })],
 *     secretKey,
 *     // No `transport` field — chargeAsync() / charge() auto-wire the
 *     // SDK-provided evmHttpTransport on the per-method transport slot
 *     // (spec §13.4.1 C2 auto-wire). Passing `transport: evmHttpTransport()`
 *     // to Mppx.create here is redundant + discouraged.
 *   })
 *
 * `evmHttpTransport` remains exported for advanced custom integrations
 * (non-Mppx.create hosts, alternate transport composition) but the
 * common path never needs it.
 */

// ── Charge factory ────────────────────────────────────────────────────────
//
// `preflightCharge(params)` is single-arg public API. The test-only
// `preflightChargeInternal` + its hooks shape stay un-exported here —
// production callers cannot bypass the Permit2 deployment probe / inject
// fake publicClient / bypass sentinel zero-address guard.
export {
  charge,
  chargeAsync,
  type ChargeServerDefaults,
  preflightCharge,
  type ResolvedChargeParams,
  type ServerParameters,
  type Split,
} from './Charge.js'

// ── Challenge binding ─────────────────────────────────────────────────────
export {
  type ChallengeBindingConfig,
  makeVerifyChallengeBinding,
  type VerifyChallengeBindingFn,
} from './ChallengeBinding.js'

// ── Challenge store (stored-lookup binding, §8.0.1) ────────────────────────
// The stored-lookup mode is unusable without these helpers — a deployment
// MUST `rememberChallenge` at issuance and the SDK looks it up at verify.
export {
  canonicalizeChallenge,
  type ChallengeItemMap,
  type ChallengeStore,
  forgetChallenge,
  lookupChallenge,
  rememberChallenge,
  type StoredChallengeAuthParams,
} from './ChallengeStore.js'

// ── Curated chain/token presets (types + lookup errors only — the matrix
//    itself is SDK-internal and consumed via preflightCharge) ─────────────
export {
  CuratedLookupError,
  type SupportedChainPreset,
  type SupportedTokenPreset,
} from './curated.js'

// ── Receipt codec ────────────────────────────────────────────────────────
export {
  buildEvmReceipt,
  deserializeEvmReceipt,
  type EvmReceipt,
  type EvmReceiptInput,
  serializeEvmReceipt,
} from './Receipt.js'

// ── Replay store ─────────────────────────────────────────────────────────
export {
  authKey,
  type ChargeStore,
  getReplaySlot,
  hashKey,
  markConsumed,
  markRejected,
  permit2Key,
  release,
  type ReplayItemMap,
  type ReplayKey,
  type ReplaySlotState,
  type ReplaySlotValue,
  ReplayStoreUnavailableError,
  reserve,
  txKey,
} from './Replay.js'

// ── Settlement signer ────────────────────────────────────────────────────
export {
  resolveSettlementSigner,
  SettlementConfigError,
  type SettlementCtx,
  type SettlementParams,
} from './Settlement.js'

// ── Transport (C2 path) ──────────────────────────────────────────────────
export { evmHttpTransport } from './Transport.js'
