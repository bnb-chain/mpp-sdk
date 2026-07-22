import { getAddress } from 'viem'

import type { PaymentRequirements, PaymentRequirementsExtra } from './Types.js'

/** Parse untrusted x402 requirements into the narrower B402 Exact contract. */
export function parseB402PaymentRequirements(value: unknown): PaymentRequirements {
  if (!isRecord(value)) throw new Error('B402 payment requirements must be an object')
  if (value['scheme'] !== 'exact') throw new Error("B402 requires scheme 'exact'")

  const network = value['network']
  if (typeof network !== 'string' || !/^eip155:\d+$/.test(network)) {
    throw new Error("B402 network must use 'eip155:<chainId>'")
  }
  const amount = value['amount']
  if (typeof amount !== 'string' || !/^[1-9]\d*$/.test(amount)) {
    throw new Error('B402 amount must be a positive atomic-unit integer')
  }
  const timeout = value['maxTimeoutSeconds']
  if (!Number.isInteger(timeout) || (timeout as number) <= 0) {
    throw new Error('B402 maxTimeoutSeconds must be a positive integer')
  }

  const extra = parseExtra(value['extra'])
  return {
    amount,
    asset: parseAddress(value['asset'], 'asset'),
    extra,
    maxTimeoutSeconds: timeout as number,
    network,
    payTo: parseAddress(value['payTo'], 'payTo'),
    scheme: 'exact',
  }
}

export function sameB402PaymentRequirements(left: unknown, right: PaymentRequirements): boolean {
  try {
    const parsed = parseB402PaymentRequirements(left)
    return (
      parsed.scheme === right.scheme &&
      parsed.network === right.network &&
      parsed.amount === right.amount &&
      sameAddress(parsed.asset, right.asset) &&
      sameAddress(parsed.payTo, right.payTo) &&
      parsed.maxTimeoutSeconds === right.maxTimeoutSeconds &&
      parsed.extra.assetTransferMethod === right.extra.assetTransferMethod &&
      parsed.extra.name === right.extra.name &&
      parsed.extra.version === right.extra.version &&
      sameAddress(parsed.extra.signerAddress, right.extra.signerAddress) &&
      optionalAddressEqual(parsed.extra.spenderAddress, right.extra.spenderAddress)
    )
  } catch {
    return false
  }
}

function parseExtra(value: unknown): PaymentRequirementsExtra {
  if (!isRecord(value)) throw new Error('B402 requirements.extra must be an object')
  const transferMethod = value['assetTransferMethod']
  if (transferMethod !== 'eip3009' && transferMethod !== 'permit2-exact') {
    throw new Error("B402 assetTransferMethod must be 'eip3009' or 'permit2-exact'")
  }
  const name = nonEmptyString(value['name'], 'extra.name')
  const version = nonEmptyString(value['version'], 'extra.version')
  const signerAddress = parseAddress(value['signerAddress'], 'extra.signerAddress')
  const spenderAddress =
    value['spenderAddress'] === undefined
      ? undefined
      : parseAddress(value['spenderAddress'], 'extra.spenderAddress')
  if (transferMethod === 'permit2-exact' && spenderAddress === undefined) {
    throw new Error('B402 permit2-exact requires extra.spenderAddress')
  }
  return {
    assetTransferMethod: transferMethod,
    name,
    signerAddress,
    ...(spenderAddress ? { spenderAddress } : {}),
    version,
  }
}

function parseAddress(value: unknown, field: string): `0x${string}` {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`B402 ${field} must be an EVM address`)
  }
  return getAddress(value)
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`B402 ${field} must be a non-empty string`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

function optionalAddressEqual(left: string | undefined, right: string | undefined): boolean {
  return left === undefined && right === undefined
    ? true
    : left !== undefined && right !== undefined && sameAddress(left, right)
}
