import { X402_VERSION } from '@bnb-chain/b402'
import { B402SupportedCache } from '@bnb-chain/b402/server'
import { getAddress } from 'viem'

import type { B402ChargeTransferMethod } from '../Methods.js'

export type ProviderSnapshot = {
  signerAddress: `0x${string}`
  spenderAddress?: `0x${string}` | undefined
}

const defaultTransferMethods = ['eip3009', 'permit2-exact'] as const

export function normalizeTransferMethods(
  methods: readonly B402ChargeTransferMethod[] | undefined,
): readonly B402ChargeTransferMethod[] {
  const requested = methods ?? defaultTransferMethods
  if (requested.length === 0) throw new Error('B402 transferMethods must not be empty')
  return [...new Set(requested)]
}

/**
 * Reuses the provider snapshot already HMAC-bound into the credential's
 * Challenge. A retry must not silently replace that snapshot after
 * `/supported` rotates signer or spender configuration.
 */
export function providerSnapshotFromCredential(
  credential: { readonly challenge?: { readonly request?: unknown } } | null | undefined,
  transferMethod: B402ChargeTransferMethod,
): ProviderSnapshot | undefined {
  const request = credential?.challenge?.request
  if (!isRecord(request)) return undefined
  const details = request['methodDetails']
  if (!isRecord(details) || details['assetTransferMethod'] !== transferMethod) return undefined
  if (!isAddress(details['signerAddress'])) return undefined
  if (transferMethod === 'permit2-exact' && !isAddress(details['spenderAddress'])) return undefined
  return {
    signerAddress: getAddress(details['signerAddress']),
    ...(isAddress(details['spenderAddress'])
      ? { spenderAddress: getAddress(details['spenderAddress']) }
      : {}),
  }
}

export async function resolveProviderSnapshot(parameters: {
  cache: B402SupportedCache
  name: string
  network: string
  transferMethod: B402ChargeTransferMethod
  version: string
}): Promise<ProviderSnapshot> {
  const supported = await parameters.cache.get()
  const kind = supported.kinds.find(
    (candidate) =>
      candidate.x402Version === X402_VERSION &&
      candidate.scheme === 'exact' &&
      candidate.network === parameters.network &&
      candidate.extra.assetTransferMethod === parameters.transferMethod &&
      candidate.extra.name === parameters.name &&
      candidate.extra.version === parameters.version,
  )
  if (!kind) {
    throw new Error(
      `B402 /supported has no exact/${parameters.transferMethod} kind named ` +
        `'${parameters.name}' (version '${parameters.version}') on ${parameters.network}`,
    )
  }
  if (!isAddress(kind.extra.signerAddress)) {
    throw new Error('B402 /supported returned an invalid signerAddress')
  }
  if (parameters.transferMethod === 'permit2-exact' && !isAddress(kind.extra.spenderAddress)) {
    throw new Error('B402 /supported returned no valid spenderAddress for permit2-exact')
  }
  return {
    signerAddress: getAddress(kind.extra.signerAddress),
    ...(parameters.transferMethod === 'permit2-exact' && isAddress(kind.extra.spenderAddress)
      ? { spenderAddress: getAddress(kind.extra.spenderAddress) }
      : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAddress(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
}
