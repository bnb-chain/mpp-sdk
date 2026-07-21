/**
 * Settlement adapters — make the on-chain "settle" step of the EIP-3009
 * `authorization` path pluggable behind a small interface. The buyer-facing
 * mppx wire is unchanged; only WHERE `transferWithAuthorization` executes
 * varies:
 *
 *   - `LocalSignerAdapter` (here) — this deployment's settlement signer
 *     broadcasts (you self-host the facilitator role; the SDK's original
 *     behaviour).
 *   - external facilitator adapters — delegate to a third party that broadcasts
 *     + pays gas. Provider-specific implementations live OUTSIDE
 *     core: this module defines only the settlement seam, never a specific
 *     facilitator.
 *
 * The verifier (`src/server/Authorization.ts`) keeps ALL challenge binding,
 * replay 3-state, front-run recovery, `terminalPhase` locking, and §7.6 receipt
 * logic — and, crucially, the trust-critical check that the settled transfer
 * matched the signed authorization. An adapter only delegates the broadcast and
 * returns a normalized `SettleReceipt` whose `proof` the verifier judges:
 *
 *   - returns `{ status, transactionHash, proof }` for a mined tx — `proof` is
 *     either the receipt `logs` (verifier matches the Transfer) or a
 *     `facilitator` echo of `payer`/`network`/`amount` (verifier asserts they
 *     equal the authorized `from`/`chainId`/`value`);
 *   - throws `SettlePendingError` when the tx was broadcast but its receipt
 *     could not be confirmed (timeout) → the verifier keeps the slot inflight;
 *   - throws any other error for a pre-mine failure → the verifier runs its
 *     front-run recovery probe (release / inflight / recovered).
 */

import {
  type Address,
  type Hex,
  type Log,
  type PublicClient,
  type WalletClient,
  parseSignature,
} from 'viem'

import type { CredentialType } from '../Methods.js'

/* -------------------------------------------------------------------------- */
/*  Interface                                                                  */
/* -------------------------------------------------------------------------- */

/** The verified EIP-3009 authorization to settle on-chain. */
export interface Eip3009Settlement {
  readonly token: Address
  readonly chainId: number
  readonly from: Address
  readonly to: Address
  readonly value: bigint
  readonly validAfter: bigint
  readonly validBefore: bigint
  readonly nonce: Hex
  /** Canonical 65-byte signature (already normalized by the verifier). */
  readonly signature: Hex
  /** Token EIP-712 domain — adapters that need it (e.g. b402 `extra`) read here. */
  readonly eip712: { readonly name: string; readonly version: string }
}

export interface SettleContext {
  readonly publicClient: PublicClient
  /** Confirmation depth for the settlement receipt wait (spec §7.5). */
  readonly confirmations: number
  /** Max ms to wait for the settlement receipt. Unset → viem default (180s). */
  readonly settlementTimeoutMs?: number
}

/**
 * Evidence an adapter hands back so the VERIFIER (not the adapter) can confirm
 * the settled transfer matched the signed authorization. Keeping the judgement
 * in core means the trust-critical check is applied uniformly to every adapter,
 * rather than re-implemented (or forgotten) per facilitator:
 *
 *   - `logs` — raw tx logs from a settler that broadcast the tx itself
 *     (`LocalSignerAdapter`). The verifier matches the authorized ERC-20
 *     `Transfer(currency, from, to, value)` against them.
 *   - `facilitator` — a TRUSTED settlement oracle (e.g. b402) broadcast the tx
 *     and ECHOES the settled `payer` / `network` / `amount` back. The verifier
 *     asserts those equal the authorized `from` / `chainId` / `value`. This is
 *     AUXILIARY defense-in-depth at zero extra cost (the fields are already in the
 *     response): it catches the facilitator settling a DIFFERENT transfer than
 *     authorized. It does NOT prove the tx mined and does NOT re-check on-chain —
 *     core trusts the facilitator's `success`; `SettleContext.confirmations` is
 *     honoured only on the `logs` (local-signer) path, which waits for the
 *     receipt itself. Need on-chain confirmation? Use `LocalSignerAdapter`.
 */
export type SettleProof =
  | { readonly kind: 'logs'; readonly logs: readonly Log[] }
  | {
      readonly kind: 'facilitator'
      /** Payer the facilitator reports it debited — must equal the authorized `from`. */
      readonly payer: Address
      /** CAIP-2 network the facilitator reports it settled on, e.g. `eip155:56`. */
      readonly network: string
      /** Settled amount (atomic units) when the facilitator echoes it. */
      readonly amount?: bigint
    }

export interface SettleReceipt {
  readonly status: 'success' | 'reverted'
  readonly transactionHash: Hex
  /** Evidence the verifier uses to confirm the transfer matched; see `SettleProof`. */
  readonly proof: SettleProof
}

/**
 * Thrown when the settlement tx was broadcast but its receipt could not be
 * confirmed (timeout). The verifier keeps the replay slot INFLIGHT (reclaimed
 * after `inflightTtlMs`) rather than releasing it — the tx may still mine and
 * burn the EIP-3009 nonce.
 */
export class SettlePendingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SettlePendingError'
  }
}

/**
 * Thrown when the settle backend DEFINITIVELY rejected the settlement BEFORE
 * any broadcast (e.g. b402 `/settle` returned `success:false` with no tx —
 * unregistered payout, bad params). Nothing reached the chain and no nonce was
 * burned by this flow, so the verifier RELEASES the replay slot and surfaces
 * the backend's reason to the buyer — in contrast to `SettlePendingError`
 * (broadcast happened, outcome unknown → the slot stays inflight).
 */
export class SettleRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SettleRejectedError'
  }
}

/**
 * Pluggable settlement backend for the EIP-3009 `authorization` path.
 *
 * v1 SCOPE: this interface covers the `authorization` (EIP-3009) credential
 * ONLY — hence the single `settleAuthorization` method and `Eip3009Settlement`
 * argument. The name is intentionally generic: when a future credential needs a
 * pluggable settle step, ADD a method (e.g. `settlePermit2`) rather than
 * generalizing this one. The machine-checkable contract is `settles`: an
 * adapter must list every `CredentialType` it actually implements, and the
 * preflight/verifier wiring only routes a credential to an adapter that
 * declares it.
 *
 * Provider-specific backends live outside core: core knows the Seam, not the
 * facilitator.
 */
export interface SettleAdapter {
  /** Credential types this adapter settles (v1: `'authorization'`). */
  readonly settles: readonly CredentialType[]
  /** Broadcast a verified EIP-3009 authorization; see module JSDoc for the contract. */
  settleAuthorization(settlement: Eip3009Settlement, ctx: SettleContext): Promise<SettleReceipt>
}

const EIP3009_TRANSFER_WITH_AUTHORIZATION_ABI = [
  {
    type: 'function',
    name: 'transferWithAuthorization',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

/* -------------------------------------------------------------------------- */
/*  LocalSignerAdapter — self-host the settlement (default)                    */
/* -------------------------------------------------------------------------- */

/**
 * Settles by broadcasting `transferWithAuthorization` from the deployment's own
 * settlement signer (which pays gas). This is the SDK's original behaviour,
 * relocated behind the adapter interface — wired automatically when no
 * `settleBackend` is configured.
 */
export class LocalSignerAdapter implements SettleAdapter {
  readonly settles = ['authorization'] as const
  readonly #signer: WalletClient

  constructor(settlementSigner: WalletClient) {
    this.#signer = settlementSigner
  }

  async settleAuthorization(s: Eip3009Settlement, ctx: SettleContext): Promise<SettleReceipt> {
    // `s.signature` is the canonical 65-byte form (verifier normalized it); the
    // yParity fallback is belt-and-braces for any future normalization gap.
    const parsed = parseSignature(s.signature)
    const v = parsed.v ?? BigInt(27 + parsed.yParity)
    const args = [
      s.from,
      s.to,
      s.value,
      s.validAfter,
      s.validBefore,
      s.nonce,
      Number(v),
      parsed.r,
      parsed.s,
    ] as const

    // simulate → write. A failure here propagates (NOT SettlePendingError), so
    // the verifier runs its front-run recovery probe.
    const { request: simRequest } = await ctx.publicClient.simulateContract({
      address: s.token,
      abi: EIP3009_TRANSFER_WITH_AUTHORIZATION_ABI,
      functionName: 'transferWithAuthorization',
      args,
      account: this.#signer.account ?? null,
    })
    const txHash = await this.#signer.writeContract({
      ...simRequest,
      chain: this.#signer.chain ?? null,
    })

    // A wait failure (timeout) keeps the slot inflight — the tx may still mine.
    let receipt: Awaited<ReturnType<PublicClient['waitForTransactionReceipt']>>
    try {
      receipt = await ctx.publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations: ctx.confirmations,
        ...(ctx.settlementTimeoutMs !== undefined && { timeout: ctx.settlementTimeoutMs }),
      })
    } catch (waitErr) {
      throw new SettlePendingError(
        `waitForTransactionReceipt failed; slot remains inflight until reclaim: ${
          waitErr instanceof Error ? waitErr.message : String(waitErr)
        }`,
      )
    }

    return {
      status: receipt.status === 'success' ? 'success' : 'reverted',
      transactionHash: txHash,
      // We broadcast it ourselves → hand the verifier the logs to match.
      proof: { kind: 'logs', logs: receipt.logs },
    }
  }
}
