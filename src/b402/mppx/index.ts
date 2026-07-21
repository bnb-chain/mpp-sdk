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
  type ChallengeBindingConfig,
  type Eip3009Settlement,
  type ServerParameters,
  type SettleAdapter,
  type SettleContext,
  SettlePendingError,
  SettleRejectedError,
  type SettleProof,
  type SettleReceipt,
  type SupportedChainPreset,
  type SupportedTokenPreset,
} from '../../server/index.js'
import { B402Client } from '../Client.js'
import {
  type B402ExactHandler,
  type B402ExactHandlerOptions,
  type B402ExactMethod,
  createB402ExactHandler,
} from '../Exact.js'
import { B402SupportedCache } from '../Supported.js'
import {
  type BazaarMetadata,
  type PaymentPayload,
  type PaymentRequirements,
  type SupportedKind,
  X402_VERSION,
} from '../Types.js'

export interface B402AdapterOptions {
  /**
   * Opt-in b402 "Bazaar" discovery metadata, attached to every `/settle` as
   * `paymentPayload.extensions.bazaar`. Safe to set: b402 skips an invalid blob
   * without failing the settle. Describes the resource being charged, so set it
   * per resource/route (one adapter per route if they differ).
   */
  readonly bazaar?: BazaarMetadata
  /**
   * Optional shared TTL cache for `/supported`. Defaults to an adapter-owned
   * five-minute cache; pass one instance to share snapshots across adapters
   * and standalone gates.
   */
  readonly supportedCache?: B402SupportedCache
}

export class B402Adapter implements SettleAdapter {
  // `authorization` (EIP-3009) ONLY — deliberately narrow. It does NOT bridge
  // mppx `permit2`: the mppx Permit2 witness (`PaymentWitness(challengeHash,externalId)`)
  // and the b402/x402 Permit2 witness (`witness.{facilitator,to}`) are different
  // protocols, not the same credential settled two ways. mppx permit2 settles
  // locally (LocalSigner); see docs/adr/0002-settle-adapter.md.
  readonly settles = ['authorization'] as const
  readonly #client: B402Client
  readonly #bazaar: BazaarMetadata | undefined
  readonly #supported: B402SupportedCache

  constructor(client: B402Client, options: B402AdapterOptions = {}) {
    this.#client = client
    this.#bazaar = options.bazaar
    this.#supported = options.supportedCache ?? new B402SupportedCache(client)
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
    // SettleReceipt carries no failure-reason field, so surface b402's
    // errorReason as an operator hint before the reverted receipt drops it.
    if (result.transaction) {
      // eslint-disable-next-line no-console -- operator hint
      console.warn(
        `[B402Adapter] /settle reverted (tx=${result.transaction}): ` +
          `${result.errorReason ?? 'no errorReason'}${result.errorMessage ? ` — ${result.errorMessage}` : ''}`,
      )
      return {
        status: 'reverted',
        transactionHash: result.transaction as Hex,
        proof: this.#facilitatorProof(result),
      }
    }
    // Failed with NO tx → the facilitator DEFINITIVELY rejected pre-broadcast
    // (unregistered payout, bad params, ...). Typed so the verifier releases
    // the slot and surfaces this reason instead of a probe artifact.
    throw new SettleRejectedError(
      `b402 settle rejected: ${result.errorReason ?? 'unknown reason'}` +
        (result.errorMessage ? ` — ${result.errorMessage}` : ''),
    )
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
    // Read a bounded cached /supported snapshot but SELECT the kind per
    // (network, name, version) on EVERY call — a single adapter may back
    // multiple tokens/networks across different charge factories. Match BOTH
    // name and version: a token upgrade can retain its name while changing the
    // EIP-712 domain version.
    const supported = await this.#supported.get()
    // Match the scheme + protocol version we actually settle as (`exact` / v2 —
    // the adapter hard-codes both below), not just the token: a `/supported`
    // entry advertising eip3009 under a different scheme/version carries an
    // `extra` we must NOT copy into an `exact`/v2 requirement.
    const kind = supported.kinds.find(
      (k) =>
        k.x402Version === X402_VERSION &&
        k.scheme === 'exact' &&
        k.network === network &&
        k.extra.assetTransferMethod === 'eip3009' &&
        k.extra.name === tokenName &&
        k.extra.version === tokenVersion,
    )
    if (!kind) {
      throw new Error(
        `b402 /supported has no exact/eip3009 (x402 v${X402_VERSION}) kind named '${tokenName}' ` +
          `(version '${tokenVersion}') on ${network} ` +
          `(extra.name + extra.version must match the token's on-chain EIP-712 domain)`,
      )
    }
    return kind
  }
}

/* -------------------------------------------------------------------------- */
/*  b402ChargeParams — the mode-3 ServerParameters in one call                 */
/* -------------------------------------------------------------------------- */

export interface B402ChargeParamsOptions {
  /** The credentialed facilitator client (see `B402Client.fromEnv`). */
  readonly client: B402Client
  /** Curated chain preset — `'bsc'` (⚠️ real funds) or `'bsc-testnet'`. */
  readonly chain: SupportedChainPreset
  /** Your REGISTERED b402 payout for this chain — b402 settles to it. */
  readonly recipient: `0x${string}`
  /** Curated token preset; defaults to `'U'` (the b402 settlement token). */
  readonly token?: SupportedTokenPreset
  /** RPC for the balance pre-checks on this chain (curated default if unset). */
  readonly rpcUrl?: string
  /** Opt-in Bazaar discovery blob, attached to every `/settle`. */
  readonly bazaar?: BazaarMetadata
  /**
   * Optional shared TTL cache for `/supported`. Pass the same instance to
   * standalone x402 gates so every b402 path observes one bounded snapshot.
   */
  readonly supportedCache?: B402SupportedCache
  /** Challenge binding; defaults to `{ mode: 'mppx-managed' }` (Mppx.create). */
  readonly challengeBinding?: ChallengeBindingConfig
}

/**
 * Assemble the `ServerParameters` for a b402-settled charge — the whole
 * "mode 3" wiring (`credentialTypes: ['authorization']` + a `B402Adapter`
 * settle backend) in one call:
 *
 * ```ts
 * const client = B402Client.fromEnv()
 * if (!client) throw new Error('b402 not configured') // fromEnv → B402Client | undefined
 * const charge = await chargeAsync(b402ChargeParams({ client, chain: 'bsc', recipient }))
 * ```
 *
 * Returns a plain object — spread it to add anything else
 * (`{ ...b402ChargeParams(...), store, amount }`). Buyers are unaffected
 * (same mppx wire); only the settle step goes through b402, which broadcasts
 * `transferWithAuthorization` and pays the gas (docs/adr/0002).
 */
export function b402ChargeParams(options: B402ChargeParamsOptions): ServerParameters {
  return {
    chain: options.chain,
    token: options.token ?? 'U',
    recipient: options.recipient,
    challengeBinding: options.challengeBinding ?? { mode: 'mppx-managed' },
    // b402 covers the authorization settle; there is no local signer, so the
    // permit2 / transaction / hash paths are deliberately not advertised.
    credentialTypes: ['authorization'],
    settleBackend: new B402Adapter(options.client, {
      ...(options.bazaar ? { bazaar: options.bazaar } : {}),
      ...(options.supportedCache ? { supportedCache: options.supportedCache } : {}),
    }),
    ...(options.rpcUrl ? { rpcUrl: options.rpcUrl } : {}),
  }
}

/* -------------------------------------------------------------------------- */
/*  Cohesive extension facade                                                  */
/* -------------------------------------------------------------------------- */

export interface B402ExtensionOptions {
  readonly client: B402Client
  /** B402 Exact methods exposed by `exact()`. */
  readonly methods?: readonly B402ExactMethod[]
  readonly supportedCache?: B402SupportedCache
}

export interface B402Extension {
  /** MPP `authorization` settlement backend; the buyer remains on the MPP wire. */
  authorizationSettlement(options?: Omit<B402AdapterOptions, 'supportedCache'>): B402Adapter
  /** Standalone x402 Exact handler supporting EIP-3009 and/or Permit2 Exact. */
  exact(
    options: Omit<B402ExactHandlerOptions, 'client' | 'methods' | 'supportedCache'>,
  ): B402ExactHandler
  /** Compatibility convenience for constructing an authorization-only MPP charge. */
  chargeParams(
    options: Omit<B402ChargeParamsOptions, 'client' | 'supportedCache'>,
  ): ServerParameters
}

/**
 * Share one credentialed client and `/supported` snapshot across the MPP
 * settlement and standalone B402 Exact paths without merging their wires.
 */
export function createB402Extension(options: B402ExtensionOptions): B402Extension {
  const supportedCache = options.supportedCache ?? new B402SupportedCache(options.client)
  const methods = options.methods ?? (['eip3009', 'permit2-exact'] as const)
  return {
    authorizationSettlement: (adapterOptions = {}) =>
      new B402Adapter(options.client, { ...adapterOptions, supportedCache }),
    exact: (handlerOptions) =>
      createB402ExactHandler({
        ...handlerOptions,
        client: options.client,
        methods,
        supportedCache,
      }),
    chargeParams: (chargeOptions) =>
      b402ChargeParams({
        ...chargeOptions,
        client: options.client,
        supportedCache,
      }),
  }
}
