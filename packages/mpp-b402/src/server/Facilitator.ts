import {
  X402_VERSION,
  isEip3009PaymentPayload,
  parseVerifyResult,
  type BazaarMetadata,
  type Eip3009PaymentPayload,
  type PaymentRequirements,
} from '@bnb-chain/b402'
import {
  B402SupportedCache,
  b402ReplayKey,
  consumeB402SlotBestEffort,
  describeB402ReplayConflict,
  releaseB402Slot,
  reserveB402Slot,
  settleB402,
  type B402ReplayStore,
  type B402SettlementUnknownHandler,
  type B402Transport,
  type FacilitatorRequest,
} from '@bnb-chain/b402/server'
import { x402 } from 'mppx'
import { getAddress } from 'viem'

/**
 * Adapts B402 to mppx's standard x402 facilitator Interface.
 *
 * This compatibility seam is intentionally EIP-3009-only because mppx's
 * standard `evm/charge` wire does not model B402's `permit2-exact` witness.
 * Use the MPP-native `b402/charge` method for Permit2 Exact.
 */
export function createB402Facilitator(
  parameters: createB402Facilitator.Parameters,
): x402.Types.Facilitator {
  const supported = parameters.supportedCache ?? new B402SupportedCache(parameters.client)
  if (!parameters.store) {
    // eslint-disable-next-line no-console -- one-time operator-facing warning
    console.warn(
      '[createB402Facilitator] no replay `store` configured — a resubmitted credential can ' +
        'reach /settle more than once. Pass a durable atomic store unless the surrounding ' +
        'pipeline already guarantees settle idempotency.',
    )
  }

  async function reconstruct(
    paymentPayload: x402.Types.PaymentPayload,
    paymentRequirements: x402.Types.PaymentRequirements,
    includeBazaar: boolean,
  ): Promise<{
    payer: `0x${string}`
    request: FacilitatorRequest
    requirements: PaymentRequirements
  }> {
    if (!('authorization' in paymentPayload.payload)) {
      throw new Error('createB402Facilitator only supports EIP-3009 authorization payloads')
    }
    const transferMethod = paymentRequirements.extra?.['assetTransferMethod']
    if (transferMethod !== 'eip3009') {
      throw new Error(
        `createB402Facilitator requires assetTransferMethod 'eip3009' (got ${String(transferMethod)})`,
      )
    }
    const name = paymentRequirements.extra?.['name']
    const version = paymentRequirements.extra?.['version']
    if (typeof name !== 'string' || !name || typeof version !== 'string' || !version) {
      throw new Error('createB402Facilitator requires token EIP-712 name and version')
    }

    const snapshot = await supported.get()
    const kind = snapshot.kinds.find(
      (candidate) =>
        candidate.x402Version === X402_VERSION &&
        candidate.scheme === 'exact' &&
        candidate.network === paymentRequirements.network &&
        candidate.extra.assetTransferMethod === 'eip3009' &&
        candidate.extra.name === name &&
        candidate.extra.version === version,
    )
    if (!kind) {
      throw new Error(
        `B402 /supported has no exact/eip3009 kind named '${name}' ` +
          `(version '${version}') on ${paymentRequirements.network}`,
      )
    }

    const requirements: PaymentRequirements = {
      amount: paymentRequirements.amount,
      asset: getAddress(paymentRequirements.asset),
      extra: {
        assetTransferMethod: 'eip3009',
        name: kind.extra.name,
        signerAddress: getAddress(kind.extra.signerAddress),
        version: kind.extra.version,
      },
      maxTimeoutSeconds: paymentRequirements.maxTimeoutSeconds,
      network: paymentRequirements.network,
      payTo: getAddress(paymentRequirements.payTo),
      scheme: 'exact',
    }
    const authorization = paymentPayload.payload.authorization
    const payment: Eip3009PaymentPayload = {
      accepted: requirements,
      ...(includeBazaar && parameters.bazaar ? { extensions: { bazaar: parameters.bazaar } } : {}),
      payload: {
        authorization: {
          from: getAddress(authorization.from),
          nonce: asBytes32(authorization.nonce),
          to: getAddress(authorization.to),
          validAfter: authorization.validAfter,
          validBefore: authorization.validBefore,
          value: authorization.value,
        },
        signature: asSignature(paymentPayload.payload.signature),
      },
      x402Version: X402_VERSION,
    }
    if (!isEip3009PaymentPayload(payment)) {
      throw new Error('B402 EIP-3009 payload does not satisfy the payment requirements')
    }
    return {
      payer: getAddress(authorization.from),
      request: {
        paymentPayload: payment,
        paymentRequirements: requirements,
        x402Version: X402_VERSION,
      },
      requirements,
    }
  }

  return {
    async verify(paymentPayload, paymentRequirements) {
      const reconstructed = await reconstruct(paymentPayload, paymentRequirements, false)
      const result = parseVerifyResult(await parameters.client.verify(reconstructed.request))
      if (result.isValid && result.payer.toLowerCase() !== reconstructed.payer.toLowerCase()) {
        return {
          invalidMessage: 'B402 verify payer does not match the signed payment',
          invalidReason: 'payer_mismatch',
          isValid: false,
          payer: result.payer,
        }
      }
      return result
    },

    async settle(paymentPayload, paymentRequirements) {
      const reconstructed = await reconstruct(paymentPayload, paymentRequirements, true)

      // ── Replay guard (audit H02): reserve BEFORE the irreversible call ──
      const store = parameters.store
      let replayKey: ReturnType<typeof b402ReplayKey> | undefined
      let slotToken: string | null = null
      if (store) {
        const payload = reconstructed.request.paymentPayload.payload
        if (!('authorization' in payload)) {
          throw new Error('createB402Facilitator only supports EIP-3009 authorization payloads')
        }
        replayKey = b402ReplayKey({
          asset: reconstructed.requirements.asset,
          network: reconstructed.requirements.network,
          nonce: payload.authorization.nonce,
          payer: reconstructed.payer,
          transferMethod: 'eip3009',
        })
        slotToken = await reserveB402Slot(store, replayKey, {
          inflightTtlMs: parameters.inflightTtlMs,
        })
        if (slotToken === null) {
          const conflict = await describeB402ReplayConflict(store, replayKey)
          throw new Error(
            conflict.state === 'consumed'
              ? 'B402 credential already consumed by a previous settlement'
              : conflict.state === 'rejected'
                ? `B402 credential previously rejected: ${conflict.reason ?? 'unknown'}`
                : 'concurrent B402 settlement in progress for this credential',
          )
        }
      }

      // A B402SettlementUnknownError must leave the slot `inflight` (the
      // transfer may already be on-chain); only a provable non-broadcast
      // (success=false ⇒ transaction === '') frees it for retry.
      const result = await settleB402({
        client: parameters.client,
        expectation: {
          payer: reconstructed.payer,
          requirements: reconstructed.requirements,
          transferMethod: 'eip3009',
        },
        ...(parameters.onSettlementUnknown
          ? { onSettlementUnknown: parameters.onSettlementUnknown }
          : {}),
        request: reconstructed.request,
      })
      if (store && replayKey && slotToken !== null) {
        if (result.success) {
          await consumeB402SlotBestEffort(store, replayKey, '[createB402Facilitator settle]')
        } else {
          await releaseB402Slot(store, replayKey, slotToken).catch(() => undefined)
        }
      }
      return result
    },
  }
}

function asBytes32(value: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error('Invalid EIP-3009 nonce')
  return value as `0x${string}`
}

function asSignature(value: string): `0x${string}` {
  if (!/^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/.test(value)) {
    throw new Error('Invalid EIP-3009 signature')
  }
  return value as `0x${string}`
}

export declare namespace createB402Facilitator {
  export type Parameters = {
    readonly bazaar?: BazaarMetadata | undefined
    readonly client: B402Transport
    /**
     * Stale-inflight reclaim age (ms) for the replay guard. Only meaningful
     * when `store` is set. Defaults to 10 minutes.
     */
    readonly inflightTtlMs?: number | undefined
    readonly onSettlementUnknown?: B402SettlementUnknownHandler | undefined
    /**
     * Replay store guarding `settle()` (audit H02): when set, each
     * credential reserves a slot before the irreversible facilitator call,
     * so a resubmission can never settle twice. STRONGLY recommended —
     * omit only when the surrounding pipeline already guarantees settle
     * idempotency. mppx `Store.redis(...)` / `Store.memory()` satisfy the
     * type structurally (memory is test/dev-only).
     */
    readonly store?: B402ReplayStore | undefined
    readonly supportedCache?: B402SupportedCache | undefined
  }
}
