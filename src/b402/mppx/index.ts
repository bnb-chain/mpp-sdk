/**
 * `@bnb-chain/mpp/b402/mppx` — the bridge between the Binance OnchainPay (b402)
 * facilitator and this SDK's mppx charge flow.
 *
 * `B402Adapter` implements the core `SettleAdapter` seam (from
 * `@bnb-chain/mpp/server`) by forwarding the verified EIP-3009 `authorization`
 * to b402, which broadcasts + sponsors gas. This is the ONLY b402 module that
 * depends on the mppx charge core; `@bnb-chain/mpp/b402` (wire) and
 * `@bnb-chain/mpp/b402/server` (the facilitator client) stay core-free, so a
 * standalone x402 integration never pulls in the charge engine.
 *
 * TRUST MODEL — b402 is a trusted settlement ORACLE, not a relayer core
 * re-confirms. Core trusts b402's `success` flag and the tx hash it returns; it
 * does NOT fetch the receipt or match on-chain Transfer logs on this path
 * (`SettleContext.confirmations` governs the LocalSigner path, not this one).
 * The `facilitator` proof cross-check (the verifier asserts the echoed
 * `payer`/`network`/`amount` equal the authorized `from`/`chainId`/`value`) is
 * AUXILIARY: it catches b402 settling a DIFFERENT transfer than authorized — it
 * does NOT catch a facilitator that fabricates `success` for a tx that never
 * landed. If you need core to independently confirm settlement on-chain, use
 * `LocalSignerAdapter` (self-host the broadcast). This adapter does NOT judge
 * the result — it MAPS the echoed fields into the proof and lets the verifier
 * (core, uniform across adapters) judge. A `success` that is INCOMPLETE (no tx
 * hash or no settled amount) is treated as pending (`SettlePendingError`, slot
 * inflight), never a fabricated success receipt.
 *
 * b402-side constraints still apply: the recipient (`to`) MUST be your
 * registered b402 payout, and the token's on-chain EIP-712 `name`+`version` must
 * match a b402 `/supported` eip3009 kind (e.g. `United Stables` v`1` for `$U`).
 */

import { type Address, type Hex } from 'viem'

import {
  type Eip3009Settlement,
  type SettleAdapter,
  type SettleContext,
  SettlePendingError,
  type SettleProof,
  type SettleReceipt,
} from '../../server/index.js'
import { B402Client } from '../Client.js'
import type {
  BazaarMetadata,
  PaymentPayload,
  PaymentRequirements,
  SupportedKind,
  SupportedResponse,
} from '../Types.js'

export interface B402AdapterOptions {
  /**
   * Opt-in b402 "Bazaar" discovery metadata, attached to every `/settle` as
   * `paymentPayload.extensions.bazaar`. Safe to set: b402 skips an invalid blob
   * without failing the settle. Describes the resource being charged, so set it
   * per resource/route (one adapter per route if they differ).
   */
  readonly bazaar?: BazaarMetadata
}

export class B402Adapter implements SettleAdapter {
  // `authorization` (EIP-3009) ONLY — deliberately narrow. It does NOT bridge
  // mppx `permit2`: the mppx Permit2 witness (`PaymentWitness(challengeHash)`)
  // and the b402/x402 Permit2 witness (`witness.{facilitator,to}`) are different
  // protocols, not the same credential settled two ways. mppx permit2 settles
  // locally (LocalSigner); see docs/adr/0002-settle-adapter.md.
  readonly settles = ['authorization'] as const
  readonly #client: B402Client
  readonly #bazaar: BazaarMetadata | undefined
  #supportedCache: SupportedResponse | undefined

  constructor(client: B402Client, options: B402AdapterOptions = {}) {
    this.#client = client
    this.#bazaar = options.bazaar
  }

  async settleAuthorization(s: Eip3009Settlement, _ctx: SettleContext): Promise<SettleReceipt> {
    const network = `eip155:${s.chainId}`
    const kind = await this.#resolveKind(network, s.eip712.name, s.eip712.version)
    const requirements: PaymentRequirements = {
      scheme: 'exact',
      network,
      amount: s.value.toString(),
      asset: s.token,
      payTo: s.to,
      maxTimeoutSeconds: 300,
      extra: kind.extra,
    }
    const paymentPayload: PaymentPayload = {
      x402Version: 2,
      accepted: requirements,
      payload: {
        signature: s.signature,
        authorization: {
          from: s.from,
          to: s.to,
          value: s.value.toString(),
          validAfter: s.validAfter.toString(),
          validBefore: s.validBefore.toString(),
          nonce: s.nonce,
        },
      },
      // Opt-in Bazaar discovery blob — b402 persists it; an invalid blob is
      // skipped by the indexer and never fails the settle.
      ...(this.#bazaar && { extensions: { bazaar: this.#bazaar } }),
    }

    const result = await this.#client.settle({
      x402Version: 2,
      paymentPayload,
      paymentRequirements: requirements,
    })

    if (result.success) {
      // The `facilitator` proof is the ONLY post-settle integrity check (core
      // does not re-fetch on-chain logs), so a `success` must be COMPLETE — a
      // valid tx hash AND a settled amount we can match against the value. An
      // incomplete success is out-of-spec MISSING info, not a definitive
      // outcome: throw SettlePendingError to keep the slot inflight (the verifier
      // reclaims it and the front-run probe resolves the real chain state) rather
      // than fabricating a reference or burning the slot. A WRONG (present but
      // mismatched) payer/network/amount is the verifier's job → it REJECTS.
      if (!/^0x[0-9a-fA-F]{64}$/.test(result.transaction)) {
        throw new SettlePendingError(
          `b402 reported success but returned no/invalid tx hash (${JSON.stringify(result.transaction)}); slot kept inflight`,
        )
      }
      if (!result.amount) {
        throw new SettlePendingError(
          'b402 reported success but echoed no settled amount; slot kept inflight',
        )
      }
      return {
        status: 'success',
        transactionHash: result.transaction as Hex,
        proof: this.#facilitatorProof(result),
      }
    }
    // Failed WITH a tx hash → on-chain revert: the verifier runs its front-run
    // probe (a front-runner may have settled the same authorization).
    if (result.transaction) {
      return {
        status: 'reverted',
        transactionHash: result.transaction as Hex,
        proof: this.#facilitatorProof(result),
      }
    }
    // Failed with NO tx (pre-broadcast rejection) → throw so the verifier's
    // front-run probe releases the slot.
    throw new Error(`b402 settle failed: ${result.errorReason ?? 'unknown reason'}`)
  }

  /**
   * Map b402's echoed settle fields into a `facilitator` proof. We do NOT
   * compare them to the authorization here — the verifier does (uniformly, in
   * core). `payer` is cast (not validated) because the verifier lowercases for
   * its comparison. `amount` is guaranteed present on a SUCCESS proof (the caller
   * throws `SettlePendingError` first if b402 omitted it); it is only optional in
   * the type because the `reverted` proof — which the verifier never reads, it
   * runs the front-run probe — may omit it.
   */
  #facilitatorProof(result: {
    payer: string
    network: string
    amount?: string
  }): Extract<SettleProof, { kind: 'facilitator' }> {
    return {
      kind: 'facilitator',
      payer: result.payer as Address,
      network: result.network,
      ...(result.amount ? { amount: BigInt(result.amount) } : {}),
    }
  }

  async #resolveKind(
    network: string,
    tokenName: string,
    tokenVersion: string,
  ): Promise<SupportedKind> {
    // Cache the /supported response (one network call) but SELECT the kind per
    // (network, name, version) on EVERY call — a single adapter may back multiple
    // tokens/networks across different charge factories. Match BOTH name and
    // version: the same token name can exist at different EIP-712 domain versions
    // (e.g. a token upgrade), and the wrong version yields a wrong domain.
    if (!this.#supportedCache) this.#supportedCache = await this.#client.supported()
    const kind = this.#supportedCache.kinds.find(
      (k) =>
        k.network === network &&
        k.extra.assetTransferMethod === 'eip3009' &&
        k.extra.name === tokenName &&
        k.extra.version === tokenVersion,
    )
    if (!kind) {
      throw new Error(
        `b402 /supported has no eip3009 kind named '${tokenName}' (version '${tokenVersion}') on ${network} ` +
          `(extra.name + extra.version must match the token's on-chain EIP-712 domain)`,
      )
    }
    return kind
  }
}
