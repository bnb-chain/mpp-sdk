/**
 * Settlement signer resolution (spec §10.2).
 *
 * Permit2 + EIP-3009 verifier paths need a viem `WalletClient` to broadcast
 * the settlement transaction. Transaction + hash paths only need a
 * `PublicClient` (no signing). preflightCharge resolves the signer once
 * and saves it to `_resolved.settlementSigner`; verifiers MUST read from
 * there rather than re-resolve (drift hazard between viem `chain` /
 * transport / RPC URL).
 *
 * Resolution precedence:
 *   1. `params.settlementWalletClient` (already configured) — used as-is
 *      after sanity guards (account present + address matches account /
 *      chain.id matches resolved chainId).
 *   2. `params.settlementAccount` (signer only) — wrap in a fresh
 *      WalletClient bound to the same `viemChain` / `transportUrl` /
 *      `chainId` used elsewhere in preflight.
 *   3. Neither set — return `undefined`. Callers (preflightCharge)
 *      decide whether that's fatal based on `resolvedCredentialTypes`.
 *
 * Sanity guards on settlementWalletClient (spec §10.2):
 *   - account is configured (rejects unconfigured / JSON-RPC-only clients)
 *   - if both settlementAccount + settlementWalletClient are passed, their
 *     addresses MUST match — otherwise sign identity drifts from execution
 *     identity and the settlement tx posts from a different sender than
 *     the user thought they configured
 *   - if walletClient.chain is set, chain.id MUST equal the resolved
 *     chainId — otherwise the transaction would target the wrong chain
 */

import { type Chain, type WalletClient, createWalletClient, http } from 'viem'

import type { Account } from '../internal/Account.js'

export interface SettlementParams {
  readonly settlementAccount?: Account
  readonly settlementWalletClient?: WalletClient
}

export interface SettlementCtx {
  readonly viemChain: Chain
  readonly transportUrl: string | undefined
  readonly chainId: number
}

/** Errors thrown by resolveSettlementSigner — separate class so callers can
 *  distinguish "settler misconfigured" from "credential-type requires settler
 *  but none provided" (the latter is preflightCharge's responsibility). */
export class SettlementConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SettlementConfigError'
  }
}

export function resolveSettlementSigner(
  params: SettlementParams,
  ctx: SettlementCtx,
): WalletClient | undefined {
  if (params.settlementWalletClient) {
    const wc = params.settlementWalletClient
    if (!wc.account) {
      throw new SettlementConfigError('settlementWalletClient must have a configured account')
    }
    if (
      params.settlementAccount &&
      params.settlementAccount.address.toLowerCase() !== wc.account.address.toLowerCase()
    ) {
      throw new SettlementConfigError(
        `settlementAccount address (${params.settlementAccount.address}) must equal ` +
          `settlementWalletClient.account.address (${wc.account.address})`,
      )
    }
    if (wc.chain && wc.chain.id !== ctx.chainId) {
      throw new SettlementConfigError(
        `settlementWalletClient.chain.id (${wc.chain.id}) must equal resolved ` +
          `chainId (${ctx.chainId})`,
      )
    }
    return wc
  }

  if (params.settlementAccount) {
    return createWalletClient({
      account: params.settlementAccount,
      chain: ctx.viemChain,
      transport: http(ctx.transportUrl),
    })
  }

  return undefined
}
