/**
 * Route derivation + selection — the pure heart of `pay()` (ADR-0003 Phase 1).
 *
 * `deriveLogicalPaths` turns a standard mpp challenge into the routes it offers;
 * `selectRoute` picks one — hard constraints FILTER, `mode` RANKS, empty →
 * fail-closed. Both are pure (no I/O) and exhaustively unit-tested. Shared
 * public types live here too so the leaf modules (facts/build/request) can
 * import them without depending on the `index` orchestrator.
 */

import type { Challenge } from 'mppx'
import type { Address, LocalAccount, PublicClient, WalletClient } from 'viem'

import type { CredentialType } from '../../Methods.js'

/* -------------------------------------------------------------------------- */
/*  Public types                                                              */
/* -------------------------------------------------------------------------- */

/** Ranking preset. Hard constraints (the policy booleans) FILTER; `mode` RANKS. */
export type PayMode = 'auto' | 'prefer-gasless' | 'require-gasless' | 'prefer-direct' | 'manual'

/**
 * A token's stable identity — the `(chainId, contract address)` pair. This is
 * the authoritative asset key (the challenge carries it on the wire); a token
 * `symbol` is display-only and MUST NOT gate a security decision (not unique,
 * trivially spoofable).
 */
export interface AssetId {
  readonly chainId: number
  readonly address: Address
}

export interface PayPolicy {
  /** Default `'auto'` (rank by the merchant's `credentialTypes` order). */
  readonly mode?: PayMode
  /** Decimal-string ceiling (e.g. `'1.00'`); compared once token decimals resolve. */
  readonly maxAmount?: string
  /**
   * Allowed assets by `(chainId, address)` — the authoritative token identity
   * from the wire. Omit to allow any. Addresses compare case-insensitively.
   * (Replaces the old symbol allowlist — symbol is display-only.)
   */
  readonly allowedAssets?: readonly AssetId[]
  /** Allowed numeric chainIds. Omit to allow any. (No display-name / chainKey — chainId is the stable identity.) */
  readonly allowedChains?: readonly number[]
  /** Allow a facilitator-trust route. No-op on the mpp wire (Phase 1). Default `true`. */
  readonly allowFacilitator?: boolean
  /** Allow a one-time Permit2 `approve` (gas). Default `true`. */
  readonly allowApproval?: boolean
  /** Allow a route where the buyer pays gas (`transaction` / `hash`). Default `true`. */
  readonly allowPayerGas?: boolean
}

/** A route as the client sees it — derived from the standard wire, never the wire itself. */
export interface LogicalPath {
  /** `<wire>:<method>`, an SDK-internal tag — never sent on the wire. */
  readonly id: string
  readonly wire: 'mpp'
  readonly method: CredentialType
  readonly chainId: number
  readonly currency: Address
  readonly amountBase: bigint
  /** Buyer pays no gas for the payment itself (server/facilitator broadcasts). */
  readonly gasless: boolean
  readonly requiresApproval: 'never' | 'if-insufficient-allowance'
  readonly trust: 'merchant-settlement' | 'payer-broadcast'
}

export interface WalletCapabilities {
  readonly canSignTypedData: boolean
  readonly canSignTransaction: boolean
  readonly canBroadcast: boolean
  readonly hasPermit2Allowance: boolean
  readonly knownEip712Domain: boolean
}

/** Resolved facts the (pure) `selectRoute` needs — all rail-agnostic. */
export interface SelectionContext {
  readonly chainId: number
  /** The token contract address from the challenge — the authoritative asset identity. */
  readonly tokenAddress: Address
  readonly amountBase: bigint
  readonly maxAmountBase?: bigint
  readonly capabilities: WalletCapabilities
  readonly routePreference?: readonly string[]
}

export type RouteSelection =
  | { readonly ok: true; readonly route: LogicalPath; readonly ranked: readonly LogicalPath[] }
  | { readonly ok: false; readonly reason: string; readonly rejected: readonly RouteRejection[] }

export interface RouteRejection {
  readonly id: string
  readonly reason: string
}

/** Viem wallet handles `pay()` drives. */
export interface WalletContext {
  readonly account: LocalAccount
  readonly publicClient: PublicClient
  readonly walletClient: WalletClient
}

/** Token EIP-712 domains keyed `${chainId}:${currency.toLowerCase()}` — needed for `authorization`. */
export type Eip712DomainMap = Readonly<
  Record<string, { readonly name: string; readonly version: string }>
>

/** Thrown when no offered route satisfies the policy (the fail-closed contract). */
export class NoAcceptableMethodError extends Error {
  readonly rejected: readonly RouteRejection[]
  constructor(reason: string, rejected: readonly RouteRejection[]) {
    super(`${reason} (rejected: ${rejected.map((r) => `${r.id}=${r.reason}`).join(', ')})`)
    this.name = 'NoAcceptableMethodError'
    this.rejected = rejected
  }
}

/* -------------------------------------------------------------------------- */
/*  Trait table                                                               */
/* -------------------------------------------------------------------------- */

interface MethodTraits {
  readonly gasless: boolean
  readonly requiresApproval: LogicalPath['requiresApproval']
  readonly trust: LogicalPath['trust']
  /** What the wallet must be able to do for this method. */
  readonly needs: 'sign-typed' | 'sign-tx' | 'broadcast'
  readonly needsEip712Domain?: boolean
}

const METHOD_TRAITS: Readonly<Record<CredentialType, MethodTraits>> = {
  // Buyer signs only; the server/facilitator broadcasts + pays gas → gasless for the buyer.
  authorization: {
    gasless: true,
    requiresApproval: 'never',
    trust: 'merchant-settlement',
    needs: 'sign-typed',
    needsEip712Domain: true,
  },
  // Buyer signs only; needs a one-time Permit2 approve (gas) unless already approved.
  permit2: {
    gasless: true,
    requiresApproval: 'if-insufficient-allowance',
    trust: 'merchant-settlement',
    needs: 'sign-typed',
  },
  // Buyer pre-signs a full EIP-1559 transfer; the server broadcasts it from the buyer's balance.
  transaction: {
    gasless: false,
    requiresApproval: 'never',
    trust: 'merchant-settlement',
    needs: 'sign-tx',
  },
  // Buyer broadcasts the transfer itself, then references the tx hash.
  hash: { gasless: false, requiresApproval: 'never', trust: 'payer-broadcast', needs: 'broadcast' },
}

/** The wire request shape `deriveLogicalPaths` / the orchestrator read off a charge challenge. */
export interface ChargeRequest {
  readonly amount: string
  readonly currency: Address
  readonly recipient: Address
  readonly methodDetails: {
    readonly chainId: number
    readonly permit2Address: Address
    readonly permit2Spender?: Address
    readonly credentialTypes?: readonly string[]
  }
}

/* -------------------------------------------------------------------------- */
/*  Derivation + selection                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Map a standard mpp challenge to the routes it offers. The order is the
 * merchant's `credentialTypes` order (used by `mode: 'auto'`). Per draft §11.2 an
 * absent `credentialTypes` means the payer-funded set.
 */
export function deriveLogicalPaths(challenge: Challenge.Challenge): LogicalPath[] {
  const request = challenge.request as unknown as ChargeRequest
  const { chainId } = request.methodDetails
  const accepted = request.methodDetails.credentialTypes ?? ['transaction', 'hash']
  const amountBase = BigInt(request.amount)
  const paths: LogicalPath[] = []
  for (const m of accepted) {
    if (!(m in METHOD_TRAITS)) continue // ignore any non-spec value defensively
    const method = m as CredentialType
    const t = METHOD_TRAITS[method]
    paths.push({
      id: `mpp:${method}`,
      wire: 'mpp',
      method,
      chainId,
      currency: request.currency,
      amountBase,
      gasless: t.gasless,
      requiresApproval: t.requiresApproval,
      trust: t.trust,
    })
  }
  return paths
}

/** Hard-constraint filter → mode rank → first. Pure; no I/O. */
export function selectRoute(
  paths: readonly LogicalPath[],
  policy: PayPolicy,
  ctx: SelectionContext,
): RouteSelection {
  const mode = policy.mode ?? 'auto'
  const allowFacilitator = policy.allowFacilitator ?? true
  const allowApproval = policy.allowApproval ?? true
  const allowPayerGas = policy.allowPayerGas ?? true
  const { capabilities: cap } = ctx
  const rejected: RouteRejection[] = []

  const viable = paths.filter((p) => {
    const reject = (reason: string): false => {
      rejected.push({ id: p.id, reason })
      return false
    }
    const t = METHOD_TRAITS[p.method]
    // capability
    if (t.needs === 'sign-typed' && !cap.canSignTypedData)
      return reject('wallet cannot sign typed data')
    if (t.needs === 'sign-tx' && !cap.canSignTransaction)
      return reject('wallet cannot pre-sign a transaction')
    if (t.needs === 'broadcast' && !cap.canBroadcast) return reject('wallet cannot broadcast')
    if (t.needsEip712Domain && !cap.knownEip712Domain)
      return reject('no known EIP-712 domain for the token')
    // hard policy — chain + asset identities come straight off the wire (authoritative)
    if (policy.allowedChains && !policy.allowedChains.includes(ctx.chainId))
      return reject(`chain ${ctx.chainId} not in allowedChains`)
    if (policy.allowedAssets && !matchesAsset(policy.allowedAssets, ctx.chainId, ctx.tokenAddress))
      return reject(`asset ${ctx.chainId}:${ctx.tokenAddress} not in allowedAssets`)
    if (ctx.maxAmountBase !== undefined && p.amountBase > ctx.maxAmountBase)
      return reject(`amount ${p.amountBase} exceeds maxAmount`)
    if (!allowPayerGas && !p.gasless)
      return reject('allowPayerGas=false and this route is buyer-funded')
    if (
      !allowApproval &&
      p.requiresApproval === 'if-insufficient-allowance' &&
      !cap.hasPermit2Allowance
    )
      return reject('allowApproval=false and a one-time Permit2 approve is required')
    if (!allowFacilitator && (p.trust as string) === 'facilitator')
      return reject('allowFacilitator=false')
    // require-gasless: a hard filter, not just a ranking
    if (mode === 'require-gasless' && !p.gasless)
      return reject('require-gasless and this route is buyer-funded')
    return true
  })

  if (viable.length === 0) {
    return { ok: false, reason: 'no acceptable payment method', rejected }
  }

  const ranked = rankRoutes(viable, mode, ctx.routePreference)
  if (ranked.length === 0) {
    return { ok: false, reason: 'no route matched routePreference', rejected }
  }
  return { ok: true, route: ranked[0] as LogicalPath, ranked }
}

function matchesAsset(allowed: readonly AssetId[], chainId: number, address: Address): boolean {
  const addr = address.toLowerCase()
  return allowed.some((a) => a.chainId === chainId && a.address.toLowerCase() === addr)
}

function rankRoutes(
  viable: readonly LogicalPath[],
  mode: PayMode,
  routePreference?: readonly string[],
): LogicalPath[] {
  // `auto` / `require-gasless` keep the merchant order (already gasless-filtered for require-*).
  if (mode === 'auto' || mode === 'require-gasless') return [...viable]
  if (mode === 'manual') {
    const order = routePreference ?? []
    return viable
      .filter((p) => order.includes(p.id))
      .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
  }
  // stable rank: a scoring key, ties preserve merchant order.
  const score = (p: LogicalPath): number => {
    if (mode === 'prefer-gasless') return p.gasless ? 0 : 1
    // prefer-direct: non-facilitator first (Phase 1: nothing is facilitator → all 0)
    return (p.trust as string) === 'facilitator' ? 1 : 0
  }
  return viable
    .map((p, i) => ({ p, i }))
    .sort((a, b) => score(a.p) - score(b.p) || a.i - b.i)
    .map((x) => x.p)
}
