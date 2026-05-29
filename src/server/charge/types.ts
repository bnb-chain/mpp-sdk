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

  // On-chain behaviour
  readonly confirmations?: number
  /** §8.4 hash verifier source-binding policy. Defaults to 'lax_from'. */
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
    readonly store: ChargeStore
    readonly verifyChallengeBinding: VerifyChallengeBindingFn
    /**
     * Effective confirmations depth used by hash + transaction verifiers.
     * Resolved from `params.confirmations` or the chain's curated default
     * (`curatedDefaultConfirmations`).
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
