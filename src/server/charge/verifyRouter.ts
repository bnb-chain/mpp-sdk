/**
 * verify hook for the EVM Charge factory (spec §10).
 *
 * Routing pipeline:
 *   1. challenge-binding check (mppx-hmac / stored-lookup)
 *   2. accepted-types gate (spec §4.2.2 / §6.3 / §4.2.3 splits collapse)
 *   3. dispatch by `credential.payload.type` to the per-verifier body,
 *      building each verifier's ctx from the resolved factory state.
 *
 * All four credential paths are live: hash + stored-lookup challenge
 * binding, transaction, permit2, authorization (EIP-3009).
 */

import { Errors, type Method } from 'mppx'
import type { PublicClient, WalletClient } from 'viem'

import type { chargeMethod } from '../../Methods.js'
import { verifyAuthorization } from '../Authorization.js'
import type { VerifyChallengeBindingFn } from '../ChallengeBinding.js'
import { verifyHash } from '../Hash.js'
import { verifyPermit2 } from '../Permit2.js'
import { type ChargeStore } from '../Replay.js'
import { verifyTransaction } from '../Transaction.js'

/**
 * Context the verify hook closes over — the resolved factory state every
 * verifier needs. Settlement-bound verifiers (permit2 / authorization)
 * additionally require `settlementSigner` + (for authorization) `eip712`.
 */
export interface VerifyRouterCtx {
  readonly verifyChallengeBinding: VerifyChallengeBindingFn
  readonly publicClient: PublicClient
  readonly store: ChargeStore
  readonly chainId: number
  readonly permit2Address: `0x${string}`
  readonly confirmations: number
  readonly hashFromPolicy: 'strict_from' | 'lax_from' | undefined
  readonly settlementSigner: WalletClient | undefined
  readonly eip712: { readonly name: string; readonly version: string } | undefined
}

/**
 * Builds the `verify` hook: routes by `credential.payload.type`.
 */
export function makeVerifyRouter(
  ctx: VerifyRouterCtx,
): NonNullable<Parameters<typeof Method.toServer<typeof chargeMethod>>[1]['verify']> {
  const {
    verifyChallengeBinding,
    publicClient,
    store,
    chainId,
    permit2Address,
    confirmations,
    hashFromPolicy,
    settlementSigner,
    eip712,
  } = ctx
  return async function verify({ credential, request }) {
    await verifyChallengeBinding(credential, request as Record<string, unknown>)

    // ─── Accepted-types gate ───────────────────────────────────────────
    //
    // BEFORE any verifier body / RPC call / store reserve, reject any
    // credential whose payload.type isn't in the challenge's advertised
    // accepted set. Spec §4.2.2 / §6.3: the accepted set is
    // `methodDetails.credentialTypes ?? ['transaction', 'hash']`. Per
    // §4.2.3, splits-bearing challenges MUST be fulfilled by permit2 —
    // the accepted set for a splits challenge collapses to ['permit2'].
    //
    // Previously the switch routed purely on payload.type, so a server
    // configured for `credentialTypes: ['hash']` would still happily
    // verify a transaction credential (because transaction's verifier
    // got called regardless of what the challenge advertised). Same
    // for a splits-bearing challenge being "fulfilled" by a single
    // hash / authorization / transaction transfer.
    const r = request as {
      methodDetails?: {
        credentialTypes?: readonly string[]
        splits?: readonly unknown[]
      }
    }
    const accepted: readonly string[] = r.methodDetails?.credentialTypes ?? ['transaction', 'hash']
    const payloadType = credential.payload.type
    if (!accepted.includes(payloadType)) {
      throw new Errors.InvalidPayloadError({
        reason:
          `credential.payload.type '${payloadType}' is not in challenge.request.methodDetails.` +
          `credentialTypes [${accepted.join(', ')}]` +
          (r.methodDetails?.credentialTypes === undefined
            ? ' (challenge omitted credentialTypes — per spec §4.2.2 / §6.3 the accepted ' +
              "default is ['transaction', 'hash'] only)"
            : ''),
      })
    }
    // Splits-bearing challenges (spec §4.2.3) collapse the accepted set
    // to permit2. The wire-schema invariant already forbids non-empty
    // splits[] alongside any non-permit2 credentialTypes (see
    // src/server/curated.ts + preflightCharge splits algorithm), but
    // be defensive: a tampered challenge that slipped through HMAC /
    // stored-lookup binding could carry splits without the matching
    // credentialTypes collapse.
    if (
      r.methodDetails?.splits !== undefined &&
      r.methodDetails.splits.length > 0 &&
      payloadType !== 'permit2'
    ) {
      throw new Errors.InvalidPayloadError({
        reason:
          `credential.payload.type '${payloadType}' cannot fulfill a splits-bearing ` +
          `challenge — spec §4.2.3 / §10 require permit2 for splits (single batch ` +
          `transaction with N+1 entries; non-permit2 types would necessarily under- ` +
          `or over-pay one of the splits).`,
      })
    }

    // ctx shared across read-only verifiers; settlement-bound verifiers
    // spread this + add settlementSigner.
    const readCtx = {
      publicClient,
      store,
      chainId,
      permit2Address,
      confirmations,
      hashFromPolicy: hashFromPolicy ?? ('lax_from' as const),
    }

    switch (credential.payload.type) {
      case 'permit2':
        if (!settlementSigner) {
          throw new Errors.VerificationFailedError({
            reason: 'permit2 verifier requires settlementSigner (preflight invariant broken)',
          })
        }
        // Route to verifyPermit2. ctx no longer carries
        // permit2Address per spec §8.1 — verifier
        // reads request.methodDetails.permit2Address (wire truth).
        return verifyPermit2({
          credential: credential as Parameters<typeof verifyPermit2>[0]['credential'],
          request: request as unknown as Parameters<typeof verifyPermit2>[0]['request'],
          ctx: {
            publicClient: readCtx.publicClient,
            store: readCtx.store,
            chainId: readCtx.chainId,
            settlementSigner,
          },
        })

      case 'authorization':
        if (!settlementSigner) {
          throw new Errors.VerificationFailedError({
            reason: 'authorization verifier requires settlementSigner (preflight invariant broken)',
          })
        }
        if (!eip712) {
          throw new Errors.VerificationFailedError({
            reason:
              'authorization verifier requires resolved EIP-712 domain (preflight invariant broken)',
          })
        }
        // Route to verifyAuthorization. ctx no longer carries
        // currency per spec §8.2 — verifier reads
        // request.currency (wire truth, draft Table 2 REQUIRED).
        return verifyAuthorization({
          credential: credential as Parameters<typeof verifyAuthorization>[0]['credential'],
          request: request as unknown as Parameters<typeof verifyAuthorization>[0]['request'],
          ctx: {
            publicClient: readCtx.publicClient,
            store: readCtx.store,
            chainId: readCtx.chainId,
            settlementSigner,
            eip712,
          },
        })

      case 'transaction':
        // Route to verifyTransaction.
        return verifyTransaction({
          credential: credential as Parameters<typeof verifyTransaction>[0]['credential'],
          request: request as unknown as Parameters<typeof verifyTransaction>[0]['request'],
          ctx: {
            publicClient: readCtx.publicClient,
            store: readCtx.store,
            chainId: readCtx.chainId,
            confirmations: readCtx.confirmations,
          },
        })

      case 'hash':
        // Route to verifyHash. Request shape comes from the
        // chargeMethod schema (defaults merged in by mppx before reaching
        // this hook); cast narrows to verifyHash's input contract.
        return verifyHash({
          credential: credential as Parameters<typeof verifyHash>[0]['credential'],
          request: request as unknown as Parameters<typeof verifyHash>[0]['request'],
          ctx: {
            publicClient: readCtx.publicClient,
            store: readCtx.store,
            chainId: readCtx.chainId,
            confirmations: readCtx.confirmations,
            hashFromPolicy: readCtx.hashFromPolicy,
          },
        })

      default:
        throw new Errors.InvalidPayloadError({
          reason: `unsupported credential payload type: ${
            (credential.payload as { type?: string }).type ?? '<missing>'
          }`,
        })
    }
  }
}
