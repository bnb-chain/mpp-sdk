/**
 * Shared types for the EVM Charge server factory (spec §10).
 *
 * The public ones (`Split`, `ServerParameters`, `ResolvedChargeParams`,
 * `ChargeServerDefaults`) are re-exported from `src/server/Charge.ts` so
 * `@bnb-chain/mpp/server` exposes a single import surface.
 * `PreflightInternalHooks` is the test-seam shape and stays internal.
 */

import type { Chain, PublicClient, WalletClient } from 'viem'

import type { Account } from '../../internal/Account.js'
import type { CredentialType } from '../../Methods.js'
import type { VerifyChallengeBindingFn } from '../ChallengeBinding.js'
import type { ChallengeBindingConfig } from '../ChallengeBinding.js'
import type { SupportedChainPreset, SupportedTokenPreset } from '../curated.js'
import type { ChargeStore } from '../Replay.js'
import type { SettleAdapter } from '../Settle.js'

/* -------------------------------------------------------------------------- */
/*  Split type                                                                */
/* -------------------------------------------------------------------------- */

export interface Split {
  readonly recipient: `0x${string}`
  readonly amount: string
  readonly memo?: string
}

/* -------------------------------------------------------------------------- */
/*  ServerParameters                                                          */
/* -------------------------------------------------------------------------- */

export interface ServerParameters {
  // Spec request fields (wire-visible)
  readonly recipient: `0x${string}`
  readonly amount?: string
  readonly description?: string
  readonly externalId?: string

  // Chain selection (v1 curated presets only — see spec §5.2)
  readonly chain: SupportedChainPreset
  /** Override the preset's default RPC URL (latency / private node). */
  readonly rpcUrl?: string
  /** Override viem Chain metadata; must NOT change chainId. */
  readonly chainOverride?: Chain

  // Token selection (v1 curated presets only — see spec §5.3)
  readonly token: SupportedTokenPreset

  // Credential selection
  readonly credentialTypes?: readonly CredentialType[]

  // Settlement signer (permit2 / authorization paths only; transaction /
  // hash do not need signing). Internal SDK config — never goes on wire.
  readonly settlementAccount?: Account
  readonly settlementWalletClient?: WalletClient

  /**
   * Override the EIP-3009 `authorization` settle step. Default:
   * `LocalSignerAdapter(settlementSigner)` (this deployment broadcasts). Set an
   * external Adapter to delegate authorization settlement; then no
   * `settlementAccount` is needed for that path. `permit2` always settles
   * locally and still needs a signer.
   */
  readonly settleBackend?: SettleAdapter

  // On-chain behaviour
  /**
   * Confirmation depth required before a credential is accepted / a
   * settlement receipt is returned (spec §7.5 server policy). Applies to the
   * paths where CORE waits on-chain: hash + transaction verification depth,
   * permit2 settlement, and `authorization` settled by the LOCAL signer
   * (`LocalSignerAdapter`). It does NOT apply to `authorization` settled by a
   * facilitator `settleBackend` (e.g. b402) — that path trusts the facilitator's
   * `success` + tx hash and does not re-fetch the receipt (see docs/b402.md
   * trust model). Defaults to the chain's curated value (reorg buffer).
   */
  readonly confirmations?: number
  /**
   * Max milliseconds the settling verifiers (permit2 / authorization /
   * transaction) wait for the settlement receipt while holding the HTTP
   * request open. Unset → viem default (180s). Deployments behind load
   * balancers with shorter idle timeouts should set this below the LB
   * timeout so clients receive a retryable error instead of a severed
   * connection (the replay slot stays inflight either way and is
   * reclaimed after `inflightTtlMs` once stale). Must be a positive safe
   * integer when present — enforced by preflightCharge at boot.
   */
  readonly settlementTimeoutMs?: number
  /**
   * Age in milliseconds after which a stale `inflight` replay slot is
   * reclaimable by a retry (see Replay.ts `reserve`). Defaults to 10
   * minutes. Enforced by preflightCharge at boot: must be a positive
   * safe integer satisfying
   * `inflightTtlMs >= (settlementTimeoutMs ?? 180_000) + 120_000`
   * (viem's default receipt-wait timeout plus a worst-case mining-delay
   * margin) — a shorter TTL would let a retry reclaim a slot whose
   * settlement is still inside `waitForTransactionReceipt` and
   * double-broadcast it.
   */
  readonly inflightTtlMs?: number
  /**
   * §8.4 hash verifier source-binding policy. Defaults to 'strict_from'
   * (audit H01): the credential must carry a `source` DID matching the
   * on-chain Transfer.from, so a bystander cannot claim a payer's
   * transaction by racing its hash to the server. Note the residual risk:
   * `source` is self-declared and unsigned — strict_from stops passive
   * hash-sniping but not an attacker who also copies the payer's address;
   * merchants selling fixed-price repeatable goods should consider
   * disabling the `hash` credential type entirely (via `credentialTypes`).
   * Set 'lax_from' only when payers legitimately send from addresses they
   * don't control (exchange withdrawals, custodial wallets).
   */
  readonly hashFromPolicy?: 'strict_from' | 'lax_from'

  // Challenge binding mode — REQUIRED, no default. See spec §8.0 / §10.
  readonly challengeBinding: ChallengeBindingConfig

  // Replay store — defaults to Store.memory() (test/dev only).
  readonly store?: ChargeStore

  // Direct wire methodDetails overrides (uncommon — usually omitted).
  /** Override canonical Permit2 deployment (fork / private chain / mirror). */
  readonly permit2Address?: `0x${string}`
  /** v1 splits configured on factory; route override forbidden (spec §10). */
  readonly splits?: readonly Split[]
}

/* -------------------------------------------------------------------------- */
/*  ResolvedChargeParams                                                      */
/* -------------------------------------------------------------------------- */

export interface ResolvedChargeParams extends ServerParameters {
  readonly _resolved: {
    readonly currency: `0x${string}`
    readonly decimals: number
    readonly chainId: number
    readonly permit2Address: `0x${string}`
    readonly resolvedCredentialTypes: readonly CredentialType[]
    readonly publicClient: PublicClient
    readonly transportUrl: string | undefined
    readonly viemChain: Chain
    readonly settlementSigner: WalletClient | undefined
    /** Resolved settle adapter for the authorization path (`params.settleBackend`). */
    readonly settleBackend: SettleAdapter | undefined
    readonly store: ChargeStore
    readonly verifyChallengeBinding: VerifyChallengeBindingFn
    /**
     * Effective confirmations depth used by ALL FOUR verifiers (hash +
     * transaction verification depth; permit2 + authorization settlement
     * receipt wait). Resolved from `params.confirmations` or the chain's
     * curated default (`curatedDefaultConfirmations`).
     */
    readonly confirmations: number
    /**
     * Curated EIP-712 domain (tokenName + tokenVersion) for the resolved
     * (chain, token) pair. Populated iff `resolvedCredentialTypes` includes
     * `'authorization'`; `undefined` otherwise. Used by verifyAuthorization
     * to construct the EIP-3009 domain at verify time.
     */
    readonly eip712: { readonly name: string; readonly version: string } | undefined
  }
}

/* -------------------------------------------------------------------------- */
/*  ChargeServerDefaults                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Concrete defaults shape that `charge()` always populates.
 *
 * Used as the second generic of the `Method.Server<...>` return type so
 * `Method.WithDefaults<request, defaults>` makes these fields OPTIONAL
 * at route call sites — `handler.evm.charge({ amount: '1000000' })`
 * type-checks because everything else comes from the factory defaults.
 * Letting TypeScript infer the type would be ergonomically equivalent
 * but fails declaration emit ("inferred type cannot be named without
 * referencing ZodMiniXxx" — zod-mini's generic shapes flow through and
 * aren't importable here). The explicit alias avoids that + serves as
 * structured documentation of what the factory baked in.
 *
 * ⚠️ `amount` is INTENTIONALLY OMITTED even though `ServerParameters.amount`
 *    is optional + the runtime defaults object includes it when set. The
 *    wire schema (`src/Methods.ts`) marks `amount` REQUIRED — exposing it
 *    here would let `handler.evm.charge({})` typecheck and then runtime
 *    schema-fail. Keep amount in route-required column so TS
 *    catches missing amount at the call site. Deployments that DO want a
 *    fixed factory-side amount pass `params.amount` (runtime still works);
 *    they just have to also pass `amount` redundantly at the route call
 *    (or `as never`-cast) to satisfy the strict type.
 */
export type ChargeServerDefaults = {
  description?: string
  externalId?: string
  currency: `0x${string}`
  recipient: `0x${string}`
  methodDetails: {
    chainId: number
    permit2Address: `0x${string}`
    /**
     * Settlement signer address (msg.sender at settlement time). Present
     * iff the deployment configured a `settlementAccount` — required for
     * permit2 / authorization credentials so the client signs typed data
     * with the right `spender`. Permit2's `PermitHash._hashWithWitness`
     * uses `msg.sender` as the spender field; signing with the Permit2
     * contract address instead caused `InvalidSigner()` reverts at
     * settlement (Permit2 spender bug fix).
     */
    permit2Spender?: `0x${string}`
    credentialTypes: CredentialType[]
    decimals: number
    splits?: Array<{ recipient: `0x${string}`; amount: string; memo?: string }>
  }
}

/* -------------------------------------------------------------------------- */
/*  PreflightInternalHooks (test seam only)                                   */
/* -------------------------------------------------------------------------- */

/**
 * Internal hooks consumed only by the test seam
 * (`test/helpers/server/preflightChargeForTest.ts`). The shape is NOT
 * exported from `@bnb-chain/mpp/server` so production callers cannot
 * reach the bypass paths (Permit2 deployment probe / publicClient /
 * sentinel zero-address rejection).
 *
 * The public `preflightCharge(params)` API is single-arg. The test
 * seam imports the unexported `preflightChargeInternal` directly.
 */
export interface PreflightInternalHooks {
  readonly isContractDeployed?: (
    publicClient: PublicClient,
    address: `0x${string}`,
  ) => Promise<boolean>
  /**
   * Override the publicClient created by preflight. Test seam — production
   * code never passes this. Used by verifier unit/integration tests to inject
   * a stub with deterministic `getTransactionReceipt` / `getBlockNumber` etc.
   */
  readonly publicClientOverride?: PublicClient
  /**
   * Bypass the sentinel-zero-address rejection. Test seam only — used by
   * live-test scaffolds that intentionally point at a not-yet-pinned curated
   * entry behind a real testnet RPC + signing keys. Production MUST leave
   * this unset; the rejection is the last guard against accidentally
   * shipping zero-address `currency` on the wire.
   */
  readonly allowSentinelTokenAddress?: boolean
}
