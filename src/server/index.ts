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
 *   })
 *
 * mppx 0.8+ preserves method-specific receipt fields through its loose
 * receipt schema. `evmHttpTransport` remains available only as an optional
 * fail-closed guard for custom hosts that want EVM-receipt validation at the
 * transport boundary.
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
  DEFAULT_INFLIGHT_TTL_MS,
  getReplaySlot,
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
  txHashKey,
} from './Replay.js'

// ── Production deployment profiles ───────────────────────────────────────
// Convenience entry point with a required replay store. The low-level
// chargeAsync(ServerParameters) factory remains available above.
export {
  productionCharge,
  type ProductionChargeParameters,
  type ProductionDeploymentProfile,
} from './Profile.js'

// ── Settlement signer ────────────────────────────────────────────────────
export {
  resolveSettlementSigner,
  SettlementConfigError,
  type SettlementCtx,
  type SettlementParams,
} from './Settlement.js'

// ── Settlement adapters (pluggable `authorization` settle step) ────────────
// Core defines only the seam + the self-host LocalSignerAdapter. Facilitator
// Provider backends live outside core; this entry point exports only the Seam.
export {
  type Eip3009Settlement,
  LocalSignerAdapter,
  type SettleAdapter,
  type SettleContext,
  SettlePendingError,
  SettleRejectedError,
  type SettleProof,
  type SettleReceipt,
} from './Settle.js'

// ── Optional fail-closed EVM receipt transport ───────────────────────────
export { evmHttpTransport } from './Transport.js'
