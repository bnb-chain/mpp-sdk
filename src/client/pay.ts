/**
 * `pay(url, { wallet, policy })` — the unified buyer surface (ADR-0003 Phase 1).
 *
 * The buyer expresses a payment INTENT (a `policy`), never a rail. `pay` fetches
 * the `402`, derives the offered routes from the standard mpp challenge, selects
 * one by the policy (hard constraints FILTER, `mode` RANKS), builds that one
 * credential with the existing `@bnb-chain/mpp/client` constructors, and retries
 * with `Authorization: Payment`.
 *
 * SCOPE (Phase 1): the mpp EVM Charge wire ONLY — the four spec credentials
 * (`authorization` / `permit2` / `transaction` / `hash`), single-wire, so there
 * is no cross-rail idempotency problem yet. The x402/b402 standalone offer and
 * the `PaymentIntentStore` are later phases (see docs/adr/0003-payment-offer-layer.md).
 * `allowFacilitator` is accepted but is a no-op here (no facilitator-trust route
 * exists on the mpp wire — a b402 SETTLE backend is invisible to the buyer).
 */

import { Challenge } from 'mppx'
import {
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type WalletClient,
  erc20Abi,
  maxUint256,
  parseUnits,
} from 'viem'

import type { CredentialType } from '../Methods.js'
import { createAuthorizationCredential } from './Authorization.js'
import { createHashCredential } from './Hash.js'
import { createPermit2Credential } from './Permit2.js'
import { createTransactionCredential } from './Transaction.js'

/* -------------------------------------------------------------------------- */
/*  Public types                                                              */
/* -------------------------------------------------------------------------- */

/** Ranking preset. Hard constraints (the policy booleans) FILTER; `mode` RANKS. */
export type PayMode = 'auto' | 'prefer-gasless' | 'require-gasless' | 'prefer-direct' | 'manual'

export interface PayPolicy {
  /** Default `'auto'` (rank by the merchant's `credentialTypes` order). */
  readonly mode?: PayMode
  /** Decimal-string ceiling (e.g. `'1.00'`); compared once token decimals resolve. */
  readonly maxAmount?: string
  /** Allowed token symbols (resolved on-chain). Omit to allow any. */
  readonly allowedTokens?: readonly string[]
  /** Allowed chains — match by numeric chainId or a `chainKey`. Omit to allow any. */
  readonly allowedChains?: readonly (number | string)[]
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
  readonly chainKey?: string
  readonly tokenSymbol?: string
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

/** Thrown when no offered route satisfies the policy (the fail-closed contract). */
export class NoAcceptableMethodError extends Error {
  readonly rejected: readonly RouteRejection[]
  constructor(reason: string, rejected: readonly RouteRejection[]) {
    super(`${reason} (rejected: ${rejected.map((r) => `${r.id}=${r.reason}`).join(', ')})`)
    this.name = 'NoAcceptableMethodError'
    this.rejected = rejected
  }
}

/**
 * Thrown when the post-payment retry did NOT succeed (non-2xx) — the buyer may
 * have signed/broadcast, but the server did not accept it, so the caller must
 * NOT treat the result as paid.
 */
export class PaymentRejectedError extends Error {
  readonly status: number
  readonly route: LogicalPath
  readonly body: string
  constructor(status: number, route: LogicalPath, body: string) {
    super(`payment via ${route.id} rejected by the server (HTTP ${status})`)
    this.name = 'PaymentRejectedError'
    this.status = status
    this.route = route
    this.body = body
  }
}

export interface WalletContext {
  readonly account: LocalAccount
  readonly publicClient: PublicClient
  readonly walletClient: WalletClient
}

export interface PayOptions {
  readonly wallet: WalletContext
  readonly policy?: PayPolicy
  /** Rail-tag order for `mode: 'manual'`, e.g. `['mpp:authorization','mpp:permit2']`. */
  readonly routePreference?: readonly string[]
  /** Token EIP-712 domains keyed `${chainId}:${currency.toLowerCase()}` — needed for `authorization`. */
  readonly eip712Domains?: Readonly<
    Record<string, { readonly name: string; readonly version: string }>
  >
  /**
   * Permit the wallet/public client to be on a DIFFERENT chain than the
   * challenge's `chainId`. Default `false` — a mismatch throws, because reading
   * allowance / approving / transferring on the wrong chain is a footgun.
   */
  readonly allowChainMismatch?: boolean
  /** Injectable fetch (testing). Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch
}

export interface PayResult {
  /** The post-payment response (200 + content on success). */
  readonly response: Response
  /** The route that was selected + settled. */
  readonly route: LogicalPath
  /** Raw `Payment-Receipt` header (decode with `deserializeEvmReceipt` if needed). */
  readonly receiptHeader: string | null
}

/* -------------------------------------------------------------------------- */
/*  Trait table + pure helpers (the design's heart — fully unit-testable)     */
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

interface ChargeRequest {
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
    // hard policy
    if (policy.allowedChains && !matchesChain(policy.allowedChains, ctx.chainId, ctx.chainKey))
      return reject(`chain ${ctx.chainId} not in allowedChains`)
    if (policy.allowedTokens) {
      if (!ctx.tokenSymbol) return reject('token symbol unresolved; cannot honor allowedTokens')
      if (!policy.allowedTokens.includes(ctx.tokenSymbol))
        return reject(`token ${ctx.tokenSymbol} not in allowedTokens`)
    }
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

function matchesChain(
  allowed: readonly (number | string)[],
  chainId: number,
  chainKey?: string,
): boolean {
  return allowed.some((a) =>
    typeof a === 'number' ? a === chainId : a === String(chainId) || a === chainKey,
  )
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

/* -------------------------------------------------------------------------- */
/*  Orchestrator                                                              */
/* -------------------------------------------------------------------------- */

export async function pay(url: string, options: PayOptions): Promise<PayResult> {
  const doFetch = options.fetch ?? fetch
  const { account, publicClient, walletClient } = options.wallet

  // 1. Fetch the 402 + parse the standard mpp challenge.
  const probe = await doFetch(url)
  if (probe.status !== 402) {
    throw new Error(`expected HTTP 402 from ${url}, got ${probe.status}`)
  }
  const wwwAuth = probe.headers.get('WWW-Authenticate')
  if (!wwwAuth) throw new Error('402 without a WWW-Authenticate header')
  const challenge = Challenge.deserialize(wwwAuth)
  const request = challenge.request as unknown as ChargeRequest
  const { chainId, permit2Address } = request.methodDetails
  const currency = request.currency
  const amountBase = BigInt(request.amount)

  // The wallet AND the public client must BOTH be on the challenge's chain —
  // otherwise we'd read allowance / approve / transfer on the wrong chain. Check
  // each INDEPENDENTLY: a wallet on the right chain does not excuse a public
  // client (the reader) pointed at another, and `??` would let exactly that
  // through. Fail closed on any present-and-divergent id unless opted out.
  if (!options.allowChainMismatch) {
    for (const [label, id] of [
      ['wallet', walletClient.chain?.id],
      ['public', publicClient.chain?.id],
    ] as const) {
      if (id !== undefined && id !== chainId) {
        throw new Error(
          `challenge is for chain ${chainId} but the ${label} client is on chain ${id} ` +
            `— point it at chain ${chainId} or pass allowChainMismatch:true to override`,
        )
      }
    }
  }

  // 2. Resolve the facts selection needs (symbol/decimals/allowance/domain).
  const [symbol, decimals] = await Promise.all([
    publicClient
      .readContract({ address: currency, abi: erc20Abi, functionName: 'symbol' })
      .catch(() => undefined),
    publicClient
      .readContract({ address: currency, abi: erc20Abi, functionName: 'decimals' })
      .catch(() => undefined),
  ])
  const allowance = await publicClient
    .readContract({
      address: currency,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [account.address, permit2Address],
    })
    .catch(() => 0n)
  const eip712 = options.eip712Domains?.[`${chainId}:${currency.toLowerCase()}`]

  // maxAmount must FAIL CLOSED: if a ceiling is set but decimals could not be
  // resolved, we cannot enforce it — refuse rather than pay past an unknown limit.
  let maxAmountBase: bigint | undefined
  if (options.policy?.maxAmount !== undefined) {
    if (decimals === undefined) {
      throw new Error(
        `policy.maxAmount is set but token decimals could not be resolved for ${currency} on ` +
          `chain ${chainId} — refusing to pay without enforcing the limit`,
      )
    }
    maxAmountBase = parseUnits(options.policy.maxAmount, decimals)
  }

  const capabilities: WalletCapabilities = {
    canSignTypedData: typeof account.signTypedData === 'function',
    canSignTransaction: typeof account.signTransaction === 'function',
    canBroadcast: typeof walletClient.writeContract === 'function',
    hasPermit2Allowance: allowance >= amountBase,
    knownEip712Domain: eip712 !== undefined,
  }

  // 3. Derive routes + select one.
  const paths = deriveLogicalPaths(challenge)
  const selection = selectRoute(paths, options.policy ?? {}, {
    chainId,
    ...(symbol !== undefined && { tokenSymbol: symbol }),
    amountBase,
    ...(maxAmountBase !== undefined && { maxAmountBase }),
    capabilities,
    ...(options.routePreference && { routePreference: options.routePreference }),
    ...(walletClient.chain?.name && { chainKey: walletClient.chain.name }),
  })
  if (!selection.ok) throw new NoAcceptableMethodError(selection.reason, selection.rejected)
  const route = selection.route

  // 4. Build the chosen credential (reusing the existing constructors).
  const credential = await buildCredential(route.method, {
    challenge,
    account,
    publicClient,
    walletClient,
    chainId,
    currency,
    recipient: request.recipient,
    amount: request.amount,
    permit2Address,
    ...(eip712 && { eip712 }),
  })

  // 5. Retry with Authorization: Payment → content + receipt.
  const response = await doFetch(url, { headers: { Authorization: credential } })
  // A non-2xx retry is NOT a successful payment — never pass the status through
  // silently as if `route` settled. (The buyer may have signed/broadcast.)
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new PaymentRejectedError(response.status, route, body)
  }
  return { response, route, receiptHeader: response.headers.get('Payment-Receipt') }
}

interface BuildContext {
  challenge: Challenge.Challenge
  account: LocalAccount
  publicClient: PublicClient
  walletClient: WalletClient
  chainId: number
  currency: Address
  recipient: Address
  amount: string
  permit2Address: Address
  eip712?: { name: string; version: string }
}

async function buildCredential(method: CredentialType, c: BuildContext): Promise<string> {
  switch (method) {
    case 'authorization': {
      if (!c.eip712) throw new Error('authorization selected but no EIP-712 domain resolved')
      return createAuthorizationCredential({
        challenge: c.challenge,
        account: c.account,
        chainId: c.chainId,
        currency: c.currency,
        recipient: c.recipient,
        amount: c.amount,
        eip712: c.eip712,
      })
    }
    case 'permit2': {
      const allowance = await c.publicClient.readContract({
        address: c.currency,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [c.account.address, c.permit2Address],
      })
      if (allowance < BigInt(c.amount)) {
        const approveTx = await c.walletClient.writeContract({
          account: c.account,
          chain: c.walletClient.chain ?? null,
          address: c.currency,
          abi: erc20Abi,
          functionName: 'approve',
          args: [c.permit2Address, maxUint256],
        })
        await c.publicClient.waitForTransactionReceipt({ hash: approveTx })
      }
      return createPermit2Credential({
        challenge: c.challenge,
        account: c.account,
        chainId: c.chainId,
        permit2Address: c.permit2Address,
        currency: c.currency,
        recipient: c.recipient,
        amount: c.amount,
        nonce: randomNonce(),
        deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
      })
    }
    case 'transaction': {
      const [nonce, fees] = await Promise.all([
        c.publicClient.getTransactionCount({ address: c.account.address, blockTag: 'pending' }),
        c.publicClient.estimateFeesPerGas().catch(async () => {
          const gasPrice = await c.publicClient.getGasPrice()
          return { maxFeePerGas: gasPrice, maxPriorityFeePerGas: gasPrice }
        }),
      ])
      return createTransactionCredential({
        challenge: c.challenge,
        account: c.account,
        chainId: c.chainId,
        currency: c.currency,
        recipient: c.recipient,
        amount: c.amount,
        nonce,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      })
    }
    case 'hash': {
      const txHash = await c.walletClient.writeContract({
        account: c.account,
        chain: c.walletClient.chain ?? null,
        address: c.currency,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [c.recipient, BigInt(c.amount)],
      })
      await c.publicClient.waitForTransactionReceipt({ hash: txHash })
      return createHashCredential({ challenge: c.challenge, hash: txHash })
    }
  }
}

function randomNonce(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let hex: Hex = '0x'
  for (const b of bytes) hex = `${hex}${b.toString(16).padStart(2, '0')}` as Hex
  return BigInt(hex)
}
