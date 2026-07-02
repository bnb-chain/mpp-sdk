/**
 * EVM Charge receipt: builder + (de)serializer (spec §13).
 *
 * draft-evm-charge-00 §7.6 Table 13 fixes the REQUIRED set of receipt
 * fields for EVM Charge:
 *
 *   method        always "evm"
 *   challengeId   the challenge.id this receipt settles
 *   reference     the on-chain settlement tx hash (32-byte hex)
 *   status        always "success" (failures use 402 + Problem Details)
 *   timestamp     RFC 3339 settlement timestamp
 *   chainId       EIP-155 chain id of the settlement chain
 *
 * Plus optional `externalId` echoed from the credential payload.
 *
 * The mppx core `Receipt.Schema` covers `method`/`reference`/`status`/
 * `timestamp`/`externalId` but does NOT model `challengeId` or `chainId`.
 * Calling `Receipt.from(...)` on an EVM Charge receipt would strip those
 * two fields silently — see spec §13.2 invariant: verifiers MUST call
 * `buildEvmReceipt(...)` directly and MUST NOT route through `Receipt.from`.
 *
 * On the wire, the receipt becomes the `Payment-Receipt` header value:
 *   - v1 ships path **C2** (spec §13.4.1): the `charge()` / `chargeAsync()`
 *     factory auto-wires `evmHttpTransport` on the per-method transport
 *     slot, so the custom transport calls `serializeEvmReceipt` directly
 *     and all draft §7.6 fields make it onto the wire regardless of mppx's
 *     default `Receipt.serialize` behaviour. Deployments do NOT need
 *     (and should NOT pass) `transport` to `Mppx.create({...})`.
 *   - Path C1 (transparent passthrough through default Transport.http)
 *     stays as v1.1 candidate (spec §20.3) once CI auto-detect is in place.
 */

/**
 * Universal (browser + Node) base64url codec.
 *
 * The receipt codec is intentionally JS-stdlib-only because the same module
 * is re-exported from `@bnb-chain/mpp` (root barrel) for browser callers
 * (`examples/client` etc.). An earlier `Buffer.from(...).toString('base64url')`
 * implementation Vite-bundled cleanly but crashed at runtime in the browser
 * with `Buffer is not defined`.
 *
 * Implementation uses `TextEncoder` + `btoa` / `TextDecoder` + `atob`
 * (all four are part of the W3C / Node 22+ stdlib — no polyfill needed).
 * The intermediate "binary string" hop is the standard
 * Uint8Array ↔ base64 bridge for `btoa`/`atob`, which only accept
 * latin-1 strings (one char = one byte). For receipt payloads (small
 * JSON, sub-kB) the per-character loops are well under any perf budget;
 * if this ever became hot we could switch to the (still-stage-2)
 * `Uint8Array.prototype.toBase64()` proposal.
 */

const TEXT_ENCODER = /* @__PURE__ */ new TextEncoder()
const TEXT_DECODER = /* @__PURE__ */ new TextDecoder()

function uint8ToBinaryString(bytes: Uint8Array): string {
  // Build via fromCharCode in a loop instead of `String.fromCharCode(...bytes)`
  // — spread would blow the call-stack arg limit (~64k on V8) for any future
  // large payload. Receipts are tiny today but the bound is free.
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
  return s
}

function binaryStringToUint8(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

const toBase64Url = (s: string): string => {
  const binary = uint8ToBinaryString(TEXT_ENCODER.encode(s))
  // btoa → base64 (+/=). Replace into URL alphabet, strip padding.
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const fromBase64Url = (url: string): string => {
  // Restore base64 alphabet + padding so atob accepts the input.
  const base64 = url.replace(/-/g, '+').replace(/_/g, '/')
  const padLen = (4 - (base64.length % 4)) % 4
  const padded = base64 + '='.repeat(padLen)
  return TEXT_DECODER.decode(binaryStringToUint8(atob(padded)))
}

/* -------------------------------------------------------------------------- */
/*  EvmReceipt type                                                           */
/* -------------------------------------------------------------------------- */

export interface EvmReceiptInput {
  /** Always 'evm' for EVM Charge — included as a parameter so callers
   *  can't accidentally route through this codec for a different method. */
  readonly method: 'evm'
  /** challenge.id that this receipt settles. */
  readonly challengeId: string
  /** Settlement tx hash (0x-prefixed 32-byte hex). */
  readonly reference: `0x${string}`
  /** Always 'success'. Failures throw + emit 402 instead of building a receipt. */
  readonly status: 'success'
  /** RFC 3339 settlement timestamp. */
  readonly timestamp: string
  /** EIP-155 chain id of the settlement chain. */
  readonly chainId: number
  /** Optional echo of credential payload externalId. */
  readonly externalId?: string
}

/**
 * Branded type guarantees `EvmReceipt` instances came through `buildEvmReceipt`
 * — verifiers that try to call `Receipt.from(...)` (which strips the extras)
 * are caught at compile time.
 */
export type EvmReceipt = EvmReceiptInput & {
  readonly __brand: 'EvmReceipt'
}

/* -------------------------------------------------------------------------- */
/*  buildEvmReceipt                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Construct an EvmReceipt with all draft §7.6 fields preserved.
 *
 * Verifiers MUST call this — NOT `Receipt.from(...)` — to build the receipt
 * they return from the Method verify hook (spec §13.2).
 */
export function buildEvmReceipt(input: EvmReceiptInput): EvmReceipt {
  // Sanity: enforce method='evm' / status='success' here too in case the
  // input was sourced from a discriminated union upstream and the type
  // narrowing happened on a different field.
  if (input.method !== 'evm') {
    throw new Error(`buildEvmReceipt requires method='evm', got '${input.method}'`)
  }
  if (input.status !== 'success') {
    throw new Error(`buildEvmReceipt requires status='success', got '${input.status}'`)
  }
  // Strip undefined externalId so JSON.stringify output is deterministic
  // (presence-of-key vs absence matters for wire byte-equality checks).
  const out: EvmReceiptInput = {
    method: input.method,
    challengeId: input.challengeId,
    reference: input.reference,
    status: input.status,
    timestamp: input.timestamp,
    chainId: input.chainId,
    ...(input.externalId !== undefined && { externalId: input.externalId }),
  }
  return out as EvmReceipt
}

/* -------------------------------------------------------------------------- */
/*  Codec                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Serialize an EvmReceipt to the `Payment-Receipt` header value.
 * Matches mppx's `Receipt.serialize` shape: base64url(JSON), no padding.
 *
 * Also runs `assertEvmReceipt` on the stripped payload before
 * encoding. The `EvmReceipt` brand is a type-system-only marker — a
 * downstream caller that does `as EvmReceipt` (e.g. in a test mock that
 * bypasses `buildEvmReceipt`) would otherwise emit a malformed
 * `Payment-Receipt` header silently. The transport (Transport.ts) already
 * asserts before its own encode; this serialize-side assert closes the
 * gap for callers that use `serializeEvmReceipt` directly (the demo /
 * client-side codec re-export from the root barrel does this).
 */
export function serializeEvmReceipt(receipt: EvmReceipt): string {
  const payload = stripBrand(receipt)
  assertEvmReceipt(payload)
  return toBase64Url(JSON.stringify(payload))
}

/**
 * Deserialize a `Payment-Receipt` header value back to an EvmReceipt.
 *
 * Fail-closed: `assertEvmReceipt` validates all draft §7.6 REQUIRED fields
 * are present AND that each carries the right runtime shape:
 *
 *   - `method`     literal 'evm'
 *   - `status`     literal 'success'   (failures use 402 + Problem Details)
 *   - `challengeId`  string
 *   - `reference`  /^0x[0-9a-fA-F]{64}$/ — 32-byte tx hash
 *   - `timestamp`  string  (RFC-3339 lexical form is caller-validated;
 *                            assertEvmReceipt only enforces typeof)
 *   - `chainId`    number
 *
 * Bad headers throw immediately rather than being silently coerced into a
 * partially-populated object. The only field whose lexical VALUE is not
 * checked here is `timestamp` (we accept any string and leave RFC-3339
 * parsing to the caller — `new Date(timestamp).toISOString()` works for
 * any sane source).
 */
export function deserializeEvmReceipt(encoded: string): EvmReceipt {
  const json = fromBase64Url(encoded)
  const parsed: unknown = JSON.parse(json)
  assertEvmReceipt(parsed)
  // assertEvmReceipt narrowed parsed to EvmReceipt; route through
  // buildEvmReceipt so the brand + sanity checks (method/status) still
  // apply — this preserves the single-construction-path invariant.
  return buildEvmReceipt(parsed as unknown as EvmReceiptInput)
}

/* -------------------------------------------------------------------------- */
/*  assertEvmReceipt — single fail-closed runtime guard                       */
/* -------------------------------------------------------------------------- */

const EVM_RECEIPT_REQUIRED_FIELDS = [
  'method',
  'challengeId',
  'reference',
  'status',
  'timestamp',
  'chainId',
] as const

/**
 * Single source of truth for "is this object a draft §7.6 EVM Charge receipt?".
 *
 * Used by:
 *   1. `deserializeEvmReceipt` — inbound parse guard so bad `Payment-Receipt`
 *      headers throw before reaching application code.
 *   2. `evmHttpTransport().respondReceipt` (src/server/Transport.ts) — outbound
 *      guard so a verifier that accidentally returned a non-EVM receipt throws
 *      before the missing-field response goes out on the wire (rather than
 *      falling back to mppx's default `Receipt.serialize`, which would strip
 *      `challengeId` / `chainId` silently).
 *
 * Fail-closed by design. Does not coerce, does not normalize.
 */
/** 0x-prefixed 32-byte hex — same shape `chargeMethod.schema` enforces for txHash. */
const BYTES32_HEX = /^0x[0-9a-fA-F]{64}$/

export function assertEvmReceipt(receipt: unknown): asserts receipt is EvmReceipt {
  if (receipt === null || typeof receipt !== 'object') {
    throw new Error('assertEvmReceipt: expected JSON object (draft §7.6)')
  }
  const r = receipt as Record<string, unknown>
  for (const key of EVM_RECEIPT_REQUIRED_FIELDS) {
    if (!(key in r)) {
      throw new Error(`assertEvmReceipt: missing required field '${key}' (draft §7.6)`)
    }
  }
  // Every draft §7.6 field gets a strict runtime check. Previously
  // only challengeId / chainId types were enforced, so a receipt with
  // `method: "tempo"` or `status: "failure"` or `reference: "garbage"` could
  // sail through assertEvmReceipt + evmHttpTransport.respondReceipt and
  // emit a malformed Payment-Receipt header on the wire. This is the
  // single fail-closed guard the C2 path leans on; tighten everything here.
  if (r.method !== 'evm') {
    throw new Error(
      `assertEvmReceipt: 'method' must be literal 'evm' (draft §7.6) — got ${JSON.stringify(r.method)}`,
    )
  }
  if (r.status !== 'success') {
    throw new Error(
      `assertEvmReceipt: 'status' must be literal 'success' (draft §7.6 — failures use 402 + Problem Details, not a receipt) — got ${JSON.stringify(r.status)}`,
    )
  }
  if (typeof r.challengeId !== 'string') {
    throw new Error("assertEvmReceipt: 'challengeId' must be string (draft §7.6)")
  }
  if (typeof r.reference !== 'string' || !BYTES32_HEX.test(r.reference)) {
    throw new Error(
      "assertEvmReceipt: 'reference' must be 0x-prefixed 32-byte hex tx hash (draft §7.6)",
    )
  }
  if (typeof r.timestamp !== 'string') {
    throw new Error("assertEvmReceipt: 'timestamp' must be RFC 3339 string (draft §7.6)")
  }
  if (typeof r.chainId !== 'number') {
    throw new Error("assertEvmReceipt: 'chainId' must be number (draft §7.6)")
  }
}

/* -------------------------------------------------------------------------- */
/*  Internal                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Strip the `__brand` marker before JSON serialization — it's a type-system
 * artifact that should not appear on the wire.
 */
function stripBrand(receipt: EvmReceipt): EvmReceiptInput {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured to drop __brand
  const { __brand, ...rest } = receipt as EvmReceipt & EvmReceiptInput
  return rest
}
