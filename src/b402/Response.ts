/**
 * Runtime parsers for the untrusted b402 response boundary.
 *
 * TypeScript types disappear at runtime; the facilitator is an external
 * system and may return a malformed or newly-shaped payload even inside a
 * successful `{ code: "000000", data }` envelope. Parse before Gate/Adapter
 * code reads nested fields so schema drift fails at the boundary with a useful
 * path instead of surfacing later as a misleading settlement error.
 */

import type {
  AssetTransferMethod,
  PaymentRequiredBody,
  PaymentRequirements,
  ResourceInfo,
  SettleResult,
  SupportedKind,
  SupportedResponse,
  VerifyResult,
} from './Types.js'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const DECIMAL = /^\d+$/
const NETWORK = /^eip155:\d+$/

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`${path} must be a string`)
  return value
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined
  return string(value, path)
}

function address(value: unknown, path: string): string {
  const out = string(value, path)
  if (!ADDRESS.test(out)) throw new Error(`${path} must be a 20-byte EVM address`)
  return out
}

function positiveNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${path} must be a positive safe integer`)
  }
  return value
}

function parseExtra(value: unknown, path: string): PaymentRequirements['extra'] | undefined {
  const extra = record(value, path)
  const methodValue = extra['assetTransferMethod']
  // `/supported` and a multi-offer 402 may advertise capabilities this SDK
  // intentionally does not implement. Ignore them without widening the
  // public payment types.
  if (methodValue !== 'eip3009' && methodValue !== 'permit2-exact') return undefined
  const method: AssetTransferMethod = methodValue
  const parsed = {
    name: string(extra['name'], `${path}.name`),
    version: string(extra['version'], `${path}.version`),
    assetTransferMethod: method,
    signerAddress: address(extra['signerAddress'], `${path}.signerAddress`),
    ...(extra['spenderAddress'] !== undefined
      ? { spenderAddress: address(extra['spenderAddress'], `${path}.spenderAddress`) }
      : {}),
  }
  if (method.startsWith('permit2-') && parsed.spenderAddress === undefined) {
    throw new Error(`${path}.spenderAddress is required for ${method}`)
  }
  return parsed
}

function parseRequirements(value: unknown, path: string): PaymentRequirements | undefined {
  const requirements = record(value, path)
  const scheme = requirements['scheme']
  if (scheme !== 'exact') return undefined
  const network = string(requirements['network'], `${path}.network`)
  if (!NETWORK.test(network)) throw new Error(`${path}.network must be 'eip155:<chainId>'`)
  const amount = string(requirements['amount'], `${path}.amount`)
  if (!DECIMAL.test(amount) || BigInt(amount) <= 0n) {
    throw new Error(`${path}.amount must be a positive decimal string`)
  }
  const extra = parseExtra(requirements['extra'], `${path}.extra`)
  if (!extra) return undefined
  return {
    scheme,
    network,
    amount,
    asset: address(requirements['asset'], `${path}.asset`) as `0x${string}`,
    payTo: address(requirements['payTo'], `${path}.payTo`) as `0x${string}`,
    maxTimeoutSeconds: positiveNumber(
      requirements['maxTimeoutSeconds'],
      `${path}.maxTimeoutSeconds`,
    ),
    extra,
  }
}

function parseResource(value: unknown, path: string): ResourceInfo {
  const resource = record(value, path)
  return {
    url: string(resource['url'], `${path}.url`),
    ...(optionalString(resource['description'], `${path}.description`) !== undefined
      ? { description: resource['description'] as string }
      : {}),
    ...(optionalString(resource['mimeType'], `${path}.mimeType`) !== undefined
      ? { mimeType: resource['mimeType'] as string }
      : {}),
  }
}

function parseKind(value: unknown, path: string): SupportedKind | undefined {
  const kind = record(value, path)
  const version = kind['x402Version']
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version <= 0) {
    throw new Error(`${path}.x402Version must be a positive safe integer`)
  }
  const scheme = kind['scheme']
  if (scheme !== 'exact') return undefined
  const network = string(kind['network'], `${path}.network`)
  if (!NETWORK.test(network)) throw new Error(`${path}.network must be 'eip155:<chainId>'`)

  const extra = parseExtra(kind['extra'], `${path}.extra`)
  if (!extra) return undefined
  return {
    x402Version: version,
    scheme,
    network,
    extra,
  }
}

/** Parse an untrusted x402 `402` JSON body before a wallet signs anything. */
export function parsePaymentRequiredBody(value: unknown): PaymentRequiredBody {
  const body = record(value, 'paymentRequired')
  const version = body['x402Version']
  if (version !== 2) throw new Error('paymentRequired.x402Version must be 2')
  if (!Array.isArray(body['accepts']) || body['accepts'].length === 0) {
    throw new Error('paymentRequired.accepts must be a non-empty array')
  }
  const accepts = body['accepts'].flatMap((requirements, index) => {
    const parsed = parseRequirements(requirements, `paymentRequired.accepts[${index}]`)
    return parsed ? [parsed] : []
  })
  if (accepts.length === 0) {
    throw new Error('paymentRequired.accepts has no supported exact payment method')
  }
  return {
    x402Version: version,
    accepts,
    ...(optionalString(body['error'], 'paymentRequired.error') !== undefined
      ? { error: body['error'] as string }
      : {}),
    ...(body['resource'] !== undefined
      ? { resource: parseResource(body['resource'], 'paymentRequired.resource') }
      : {}),
  }
}

export function parseSupportedResponse(value: unknown): SupportedResponse {
  const data = record(value, 'supported')
  if (!Array.isArray(data['kinds'])) throw new Error('supported.kinds must be an array')
  if (!Array.isArray(data['extensions'])) throw new Error('supported.extensions must be an array')
  const signers = record(data['signers'], 'supported.signers')

  const parsedSigners: Record<string, readonly string[]> = {}
  for (const [network, values] of Object.entries(signers)) {
    if (!Array.isArray(values)) {
      throw new Error(`supported.signers.${network} must be an array`)
    }
    parsedSigners[network] = values.map((signer, index) =>
      address(signer, `supported.signers.${network}[${index}]`),
    )
  }

  const kinds = data['kinds'].flatMap((kind, index) => {
    const parsed = parseKind(kind, `supported.kinds[${index}]`)
    return parsed ? [parsed] : []
  })
  return {
    kinds,
    extensions: data['extensions'].map((extension, index) =>
      string(extension, `supported.extensions[${index}]`),
    ),
    signers: parsedSigners,
  }
}

export function parseVerifyResult(value: unknown): VerifyResult {
  const data = record(value, 'verify')
  if (typeof data['isValid'] !== 'boolean') throw new Error('verify.isValid must be a boolean')
  const payer = string(data['payer'], 'verify.payer')
  if (data['isValid'] && !ADDRESS.test(payer)) {
    throw new Error('verify.payer must be a 20-byte EVM address when isValid is true')
  }
  return {
    isValid: data['isValid'],
    payer,
    ...(optionalString(data['invalidReason'], 'verify.invalidReason') !== undefined
      ? { invalidReason: data['invalidReason'] as string }
      : {}),
    ...(optionalString(data['invalidMessage'], 'verify.invalidMessage') !== undefined
      ? { invalidMessage: data['invalidMessage'] as string }
      : {}),
  }
}

export function parseSettleResult(value: unknown): SettleResult {
  const data = record(value, 'settle')
  if (typeof data['success'] !== 'boolean') throw new Error('settle.success must be a boolean')
  const transaction = string(data['transaction'], 'settle.transaction')
  const payer = string(data['payer'], 'settle.payer')
  const network = string(data['network'], 'settle.network')
  const amount = optionalString(data['amount'], 'settle.amount')
  if (amount !== undefined && !DECIMAL.test(amount)) {
    throw new Error('settle.amount must be a decimal string')
  }
  if (data['success'] && !ADDRESS.test(payer)) {
    throw new Error('settle.payer must be a 20-byte EVM address when success is true')
  }
  return {
    success: data['success'],
    transaction,
    payer,
    network,
    ...(amount !== undefined ? { amount } : {}),
    ...(optionalString(data['errorReason'], 'settle.errorReason') !== undefined
      ? { errorReason: data['errorReason'] as string }
      : {}),
    ...(optionalString(data['errorMessage'], 'settle.errorMessage') !== undefined
      ? { errorMessage: data['errorMessage'] as string }
      : {}),
  }
}
