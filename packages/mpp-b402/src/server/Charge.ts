import { X402_VERSION, parseVerifyResult, type BazaarMetadata } from '@bnb-chain/b402'
import {
  B402SupportedCache,
  b402ReplayKey,
  consumeB402SlotBestEffort,
  describeB402ReplayConflict,
  markB402Rejected,
  releaseB402Slot,
  reserveB402Slot,
  settleB402,
  type B402ReplayStore,
  type B402SettlementUnknownHandler,
  type B402Transport,
  type FacilitatorRequest,
} from '@bnb-chain/b402/server'
import { Errors, Method } from 'mppx'
import { getAddress } from 'viem'

import {
  chargeMethod,
  type B402ChargeCredentialPayload,
  type B402ChargeRequest,
  type B402ChargeTransferMethod,
} from '../Methods.js'
import {
  normalizeTransferMethods,
  providerSnapshotFromCredential,
  resolveProviderSnapshot,
} from './ProviderSnapshot.js'
import { toMppReceipt } from './ReceiptMapping.js'
import { assertAddressEqual, reconstructPayment } from './ReconstructPayment.js'

/** Creates the MPP-native `b402/charge` server method. */
export async function charge(
  parameters: charge.Parameters,
): Promise<Method.Server<typeof chargeMethod, charge.Defaults>> {
  const supported = parameters.supportedCache ?? new B402SupportedCache(parameters.client)
  const transferMethods = normalizeTransferMethods(parameters.transferMethods)
  const resolvedSnapshots = await Promise.all(
    transferMethods.map(
      async (transferMethod) =>
        [
          transferMethod,
          await resolveProviderSnapshot({
            cache: supported,
            name: parameters.currency.name,
            network: parameters.network,
            transferMethod,
            version: parameters.currency.version,
          }),
        ] as const,
    ),
  )
  const providerSnapshots: charge.Defaults['providerSnapshots'] = {}
  for (const [method, snapshot] of resolvedSnapshots) {
    if (method === 'eip3009') providerSnapshots.eip3009 = snapshot
    else providerSnapshots.permit2Exact = snapshot
  }

  return Method.toServer<typeof chargeMethod, charge.Defaults>(chargeMethod, {
    defaults: {
      currency: getAddress(parameters.currency.address),
      decimals: parameters.currency.decimals,
      maxTimeoutSeconds: parameters.maxTimeoutSeconds ?? 300,
      network: parameters.network,
      providerSnapshots,
      recipient: getAddress(parameters.recipient),
      tokenName: parameters.currency.name,
      tokenVersion: parameters.currency.version,
    },

    async request({ credential, request }) {
      if (!transferMethods.includes(request.transferMethod)) {
        throw new Error(`B402 transfer method is not enabled: ${request.transferMethod}`)
      }

      const previous = providerSnapshotFromCredential(credential, request.transferMethod)
      const providerSnapshot =
        previous ??
        (await resolveProviderSnapshot({
          cache: supported,
          name: request.tokenName,
          network: request.network,
          transferMethod: request.transferMethod,
          version: request.tokenVersion,
        }))

      return { ...request, providerSnapshot }
    },

    stableBinding(request) {
      return {
        amount: request.amount,
        currency: request.currency,
        ...(request.externalId !== undefined ? { externalId: request.externalId } : {}),
        methodDetails: {
          assetTransferMethod: request.methodDetails.assetTransferMethod,
          decimals: request.methodDetails.decimals,
          eip712: request.methodDetails.eip712,
          maxTimeoutSeconds: request.methodDetails.maxTimeoutSeconds,
          network: request.methodDetails.network,
          protocolVersion: request.methodDetails.protocolVersion,
        },
        recipient: request.recipient,
      }
    },

    async verify({ credential }) {
      const request = credential.challenge.request as B402ChargeRequest
      const credentialPayload = credential.payload as B402ChargeCredentialPayload
      const reconstructed = await reconstructPayment({ credentialPayload, credential, request })

      // ── Replay guard (audit H02): reserve BEFORE any facilitator call ──
      // Keyed on the credential's protocol identity; `payer` is the locally
      // recovered signer (see reconstructPayment), never the stated field.
      const replayKey = b402ReplayKey({
        asset: request.currency,
        network: request.methodDetails.network,
        nonce:
          credentialPayload.type === 'eip3009'
            ? credentialPayload.authorization.nonce
            : credentialPayload.permit2Authorization.nonce,
        payer: reconstructed.payer,
        transferMethod: request.methodDetails.assetTransferMethod,
      })
      const slotToken = await reserveB402Slot(parameters.store, replayKey, {
        inflightTtlMs: parameters.inflightTtlMs,
      })
      if (slotToken === null) {
        const conflict = await describeB402ReplayConflict(parameters.store, replayKey)
        throw new Errors.VerificationFailedError({
          reason:
            conflict.state === 'consumed'
              ? 'B402 credential already consumed by a previous settlement'
              : conflict.state === 'rejected'
                ? `B402 credential previously rejected: ${conflict.reason ?? 'unknown'}`
                : 'concurrent B402 verification in progress for this credential',
        })
      }

      // From here on: `settlePhase` flips to true right before the
      // irreversible settle call. Failures BEFORE that point release the
      // slot for a clean retry (markRejected paths write a terminal state
      // first, making the safety-net release a noop). Failures AFTER it —
      // including B402SettlementUnknownError — must leave the slot
      // `inflight`: the transfer may already be on-chain, and releasing
      // would re-admit the same credential → double settlement. The
      // stale-inflight TTL reclaims the slot after the reconciliation
      // window.
      let settlePhase = false
      try {
        const verifyRequest: FacilitatorRequest = {
          paymentPayload: reconstructed.payment,
          paymentRequirements: reconstructed.requirements,
          x402Version: X402_VERSION,
        }
        const verified = parseVerifyResult(await parameters.client.verify(verifyRequest))
        if (!verified.isValid) {
          const reason =
            verified.invalidMessage ?? verified.invalidReason ?? 'B402 facilitator rejected payment'
          await markB402Rejected(parameters.store, replayKey, reason)
          throw new Errors.VerificationFailedError({ reason })
        }
        try {
          assertAddressEqual(
            verified.payer,
            reconstructed.payer,
            'B402 verify payer does not match the signed payment',
          )
        } catch (err) {
          await markB402Rejected(
            parameters.store,
            replayKey,
            'B402 verify payer does not match the signed payment',
          )
          throw err
        }

        const settleRequest: FacilitatorRequest = {
          ...verifyRequest,
          paymentPayload: parameters.bazaar
            ? { ...reconstructed.payment, extensions: { bazaar: parameters.bazaar } }
            : reconstructed.payment,
        }
        settlePhase = true
        const settlement = await settleB402({
          client: parameters.client,
          expectation: {
            payer: reconstructed.payer,
            requirements: reconstructed.requirements,
            transferMethod: request.methodDetails.assetTransferMethod,
          },
          ...(parameters.onSettlementUnknown
            ? { onSettlementUnknown: parameters.onSettlementUnknown }
            : {}),
          request: settleRequest,
        })
        if (!settlement.success) {
          // settleB402's contract: success=false implies transaction === ''
          // (anything ambiguous threw B402SettlementUnknownError instead),
          // so nothing was broadcast and the slot may free for retry.
          settlePhase = false
          throw new Errors.VerificationFailedError({
            reason:
              settlement.errorMessage ??
              settlement.errorReason ??
              'B402 facilitator settlement failed',
          })
        }

        await consumeB402SlotBestEffort(parameters.store, replayKey, '[b402/charge verify]')

        return toMppReceipt({
          challengeId: credential.challenge.id,
          externalId: request.externalId,
          network: request.methodDetails.network,
          payer: reconstructed.payer,
          transaction: settlement.transaction,
          transferMethod: request.methodDetails.assetTransferMethod,
        })
      } catch (err) {
        if (!settlePhase) {
          // Noop when a markRejected above already wrote a terminal state
          // (release only deletes an `inflight` slot owned by this token).
          // Swallow store failures here so they never mask the real error.
          await releaseB402Slot(parameters.store, replayKey, slotToken).catch(() => undefined)
        }
        throw err
      }
    },
  })
}

export declare namespace charge {
  export type Currency = {
    /** Token contract address. */
    readonly address: `0x${string}`
    /** Token decimal places used to normalize route display amounts. */
    readonly decimals: number
    /** Token EIP-712 domain name, not ticker symbol. */
    readonly name: string
    /** Token EIP-712 domain version. */
    readonly version: string
  }

  export type Parameters = {
    readonly bazaar?: BazaarMetadata | undefined
    readonly client: B402Transport
    readonly currency: Currency
    /**
     * Stale-inflight reclaim age (ms) for the replay guard — the operator's
     * window to reconcile a `B402SettlementUnknownError` before a retry may
     * re-enter settlement. Defaults to 10 minutes.
     */
    readonly inflightTtlMs?: number | undefined
    readonly maxTimeoutSeconds?: number | undefined
    readonly network: `eip155:${number}`
    readonly onSettlementUnknown?: B402SettlementUnknownHandler | undefined
    readonly recipient: `0x${string}`
    /**
     * Replay store — REQUIRED (audit H02). Every credential reserves a slot
     * here before the facilitator's verify/settle run, so a resubmitted
     * credential (client retry, duplicate request, deliberate replay) can
     * never settle twice. Production deployments MUST pass a durable atomic
     * backend (e.g. mppx `Store.redis(...)`) shared by ALL instances;
     * `Store.memory()` guards a single process only and is test/dev-only.
     */
    readonly store: B402ReplayStore
    readonly supportedCache?: B402SupportedCache | undefined
    /** Enabled route methods. Defaults to both supported B402 methods. */
    readonly transferMethods?: readonly B402ChargeTransferMethod[] | undefined
  }

  export type Defaults = {
    currency: `0x${string}`
    decimals: number
    maxTimeoutSeconds: number
    network: `eip155:${number}`
    providerSnapshots: {
      eip3009?: ProviderSnapshot | undefined
      permit2Exact?: ProviderSnapshot | undefined
    }
    recipient: `0x${string}`
    tokenName: string
    tokenVersion: string
  }

  export type RouteOptions = {
    readonly amount: string
    readonly description?: string | undefined
    readonly externalId?: string | undefined
    readonly transferMethod: B402ChargeTransferMethod
  }

  export type ProviderSnapshot = import('./ProviderSnapshot.js').ProviderSnapshot
}
