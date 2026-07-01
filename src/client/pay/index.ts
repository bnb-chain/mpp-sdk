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
 * A b402 SETTLE backend is invisible to the buyer (a merchant-side choice), so
 * Phase 1 exposes no facilitator-trust route and no `allowFacilitator` filter —
 * those arrive with the standalone x402/b402 rail in a later phase.
 *
 * This module is deliberately thin — orchestration only. The pieces live in
 * sibling modules: `routes` (derive/select + types), `facts` (chain guard +
 * on-chain reads), `build` (credential constructors), `request` (probe/retry).
 */

import { buildCredential } from './build.js'
import { assertChainConsistency, resolveFacts } from './facts.js'
import {
  type PayRequestInit,
  type PayResult,
  assertRequest,
  probeChallenge,
  submitPayment,
} from './request.js'
import {
  type ChargeRequest,
  type Eip712DomainMap,
  NoAcceptableMethodError,
  type PayPolicy,
  type WalletContext,
  deriveLogicalPaths,
  selectRoute,
} from './routes.js'

export interface PayOptions {
  readonly wallet: WalletContext
  readonly policy?: PayPolicy
  /**
   * The caller's own HTTP request reused for the probe + paid retry — method,
   * headers, and a replayable body. Omit for a plain `GET`. Put application
   * auth in a header OTHER than `Authorization` (`X-Api-Key`, `Cookie`,
   * `Accept`, an idempotency key, ...) — `Authorization` is reserved for the
   * payment credential the retry sets and is rejected here up front.
   */
  readonly request?: PayRequestInit
  /** Rail-tag order for `mode: 'manual'`, e.g. `['mpp:authorization','mpp:permit2']`. */
  readonly routePreference?: readonly string[]
  /** Token EIP-712 domains keyed `${chainId}:${currency.toLowerCase()}` — needed for `authorization`. */
  readonly eip712Domains?: Eip712DomainMap
  /**
   * Skip the chain-consistency guard entirely. Default `false` — `pay()` refuses
   * both a client that DECLARES a different chain than the challenge's `chainId`
   * AND a fully chain-less client pair it cannot confirm, because reading
   * allowance / approving / transferring on the wrong chain is a footgun. Set
   * `true` to take responsibility for pointing the clients at the right chain.
   */
  readonly allowChainMismatch?: boolean
  /** Injectable fetch (testing). Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch
}

export async function pay(url: string, options: PayOptions): Promise<PayResult> {
  const doFetch = options.fetch ?? fetch
  const { wallet } = options

  // 1. Fetch the 402 (reusing the caller's request) + parse the mpp challenge.
  assertRequest(options.request)
  const challenge = await probeChallenge(doFetch, url, options.request)
  const request = challenge.request as unknown as ChargeRequest
  const { chainId, permit2Address } = request.methodDetails
  const currency = request.currency
  const amountBase = BigInt(request.amount)

  // 2. Guard the chain, then resolve the facts selection + build need.
  assertChainConsistency(wallet, chainId, options.allowChainMismatch ?? false)
  const facts = await resolveFacts({
    wallet,
    chainId,
    currency,
    permit2Address,
    amountBase,
    ...(options.policy?.maxAmount !== undefined && { maxAmount: options.policy.maxAmount }),
    ...(options.eip712Domains && { eip712Domains: options.eip712Domains }),
  })

  // 3. Derive routes + select one (fail-closed if the policy admits none).
  const paths = deriveLogicalPaths(challenge)
  const selection = selectRoute(paths, options.policy ?? {}, {
    chainId,
    tokenAddress: currency,
    amountBase,
    ...(facts.maxAmountBase !== undefined && { maxAmountBase: facts.maxAmountBase }),
    capabilities: facts.capabilities,
    ...(options.routePreference && { routePreference: options.routePreference }),
  })
  if (!selection.ok) throw new NoAcceptableMethodError(selection.reason, selection.rejected)
  const route = selection.route

  // 4. Build the chosen credential (reusing the existing constructors).
  const credential = await buildCredential(route.method, {
    challenge,
    account: wallet.account,
    publicClient: wallet.publicClient,
    walletClient: wallet.walletClient,
    chainId,
    currency,
    recipient: request.recipient,
    amount: request.amount,
    permit2Address,
    allowApproval: options.policy?.allowApproval ?? true,
    route,
    ...(facts.eip712 && { eip712: facts.eip712 }),
  })

  // 5. Retry with Authorization: Payment → content + receipt (fail-closed on non-2xx).
  return submitPayment(doFetch, url, options.request, credential, route)
}

/* Public surface — errors, pure selection helpers, and every buyer-facing type. */
export {
  type AssetId,
  type Eip712DomainMap,
  type LogicalPath,
  NoAcceptableMethodError,
  type PayMode,
  type PayPolicy,
  type RouteRejection,
  type RouteSelection,
  type SelectionContext,
  type WalletCapabilities,
  type WalletContext,
  deriveLogicalPaths,
  selectRoute,
} from './routes.js'
export {
  type PayRequestInit,
  type PayResult,
  type PaymentSideEffectContext,
  PaymentRejectedError,
  PaymentSideEffectError,
} from './request.js'
