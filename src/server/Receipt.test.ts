/**
 * EvmReceipt builder + codec invariants (spec §13, v2.28 assertEvmReceipt).
 *
 *   - buildEvmReceipt enforces method='evm' / status='success' at runtime
 *   - undefined externalId is stripped from output (deterministic JSON)
 *   - codec round-trip preserves all draft §7.6 fields
 *   - deserialize rejects payloads missing any REQUIRED field
 *   - serialize output is base64url (no padding, URL alphabet)
 *   - assertEvmReceipt is the single fail-closed guard (also reused by
 *     evmHttpTransport.respondReceipt outbound — see Transport.test.ts)
 */

import { Receipt } from 'mppx'
import { describe, expect, test } from 'vitest'

import {
  assertEvmReceipt,
  buildEvmReceipt,
  deserializeEvmReceipt,
  serializeEvmReceipt,
} from './Receipt.js'

const REFERENCE = '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789' as const
const TIMESTAMP = '2026-05-28T01:00:00Z'

const minimal = () =>
  buildEvmReceipt({
    method: 'evm',
    status: 'success',
    challengeId: 'chal_abc',
    reference: REFERENCE,
    timestamp: TIMESTAMP,
    chainId: 97,
  })

/* -------------------------------------------------------------------------- */
/*  buildEvmReceipt                                                           */
/* -------------------------------------------------------------------------- */

describe('buildEvmReceipt', () => {
  test('happy path returns object with all draft §7.6 fields', () => {
    const r = minimal()
    expect(r.method).toBe('evm')
    expect(r.challengeId).toBe('chal_abc')
    expect(r.reference).toBe(REFERENCE)
    expect(r.status).toBe('success')
    expect(r.timestamp).toBe(TIMESTAMP)
    expect(r.chainId).toBe(97)
  })

  test('omits externalId key when undefined (deterministic JSON)', () => {
    const r = minimal()
    expect(r).not.toHaveProperty('externalId')
  })

  test('preserves externalId when provided', () => {
    const r = buildEvmReceipt({
      method: 'evm',
      status: 'success',
      challengeId: 'chal_abc',
      reference: REFERENCE,
      timestamp: TIMESTAMP,
      chainId: 97,
      externalId: 'order-42',
    })
    expect(r.externalId).toBe('order-42')
  })

  test('rejects method != evm', () => {
    expect(() =>
      buildEvmReceipt({
        method: 'tempo' as unknown as 'evm',
        status: 'success',
        challengeId: 'chal_abc',
        reference: REFERENCE,
        timestamp: TIMESTAMP,
        chainId: 97,
      }),
    ).toThrow(/method.*evm/)
  })

  test('rejects status != success', () => {
    expect(() =>
      buildEvmReceipt({
        method: 'evm',
        status: 'pending' as unknown as 'success',
        challengeId: 'chal_abc',
        reference: REFERENCE,
        timestamp: TIMESTAMP,
        chainId: 97,
      }),
    ).toThrow(/status.*success/)
  })
})

/* -------------------------------------------------------------------------- */
/*  Codec round-trip                                                          */
/* -------------------------------------------------------------------------- */

describe('serialize / deserialize round-trip', () => {
  test('mppx 0.8 loose Receipt.Schema preserves method-specific fields', () => {
    const parsed = Receipt.from({ ...minimal() })
    const back = Receipt.deserialize(Receipt.serialize(parsed)) as typeof parsed & {
      challengeId: string
      chainId: number
    }
    expect(back.challengeId).toBe('chal_abc')
    expect(back.chainId).toBe(97)
  })

  test('preserves challengeId + chainId method-specific fields', () => {
    const r = minimal()
    const wire = serializeEvmReceipt(r)
    const back = deserializeEvmReceipt(wire)
    expect(back.challengeId).toBe('chal_abc')
    expect(back.chainId).toBe(97)
  })

  test('preserves all 7 fields including externalId', () => {
    const r = buildEvmReceipt({
      method: 'evm',
      status: 'success',
      challengeId: 'chal_abc',
      reference: REFERENCE,
      timestamp: TIMESTAMP,
      chainId: 97,
      externalId: 'order-42',
    })
    const back = deserializeEvmReceipt(serializeEvmReceipt(r))
    expect(back).toMatchObject({
      method: 'evm',
      status: 'success',
      challengeId: 'chal_abc',
      reference: REFERENCE,
      timestamp: TIMESTAMP,
      chainId: 97,
      externalId: 'order-42',
    })
  })

  test('serialize output is base64url (no padding, URL alphabet)', () => {
    const wire = serializeEvmReceipt(minimal())
    // base64url uses [A-Za-z0-9_-]; no '=' (no padding), no '+', no '/'.
    expect(wire).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  test('strips internal __brand from the wire JSON', () => {
    const wire = serializeEvmReceipt(minimal())
    // Decode and assert __brand absent.
    const json = Buffer.from(wire, 'base64url').toString('utf8')
    expect(JSON.parse(json)).not.toHaveProperty('__brand')
  })

  // The codec is universal (browser + Node) — must not depend on
  // Node's `Buffer` global. Earlier `Buffer.from(...).toString('base64url')`
  // Vite-bundled cleanly but crashed in the browser with `Buffer is not
  // defined`. Clobber the global before the codec call to prove it relies
  // only on `TextEncoder` / `TextDecoder` / `btoa` / `atob`.
  test('serialize + deserialize work without Node Buffer (browser-safe)', () => {
    const saved = (globalThis as { Buffer?: unknown }).Buffer
    ;(globalThis as { Buffer?: unknown }).Buffer = undefined
    try {
      const r = minimal()
      const wire = serializeEvmReceipt(r)
      expect(wire).toMatch(/^[A-Za-z0-9_-]+$/)
      const back = deserializeEvmReceipt(wire)
      expect(back).toMatchObject({
        method: 'evm',
        status: 'success',
        challengeId: 'chal_abc',
        chainId: 97,
      })
    } finally {
      ;(globalThis as { Buffer?: unknown }).Buffer = saved
    }
  })

  test('round-trip survives non-ASCII characters in externalId (TextEncoder UTF-8 path)', () => {
    const r = buildEvmReceipt({
      method: 'evm',
      status: 'success',
      challengeId: 'chal_abc',
      reference: REFERENCE,
      timestamp: TIMESTAMP,
      chainId: 97,
      // Exercises every UTF-8 byte-length code path through
      // TextEncoder/TextDecoder + btoa/atob's latin-1 bridge:
      //   ASCII letters    → 1-byte UTF-8
      //   Latin-1 'é'      → 2-byte UTF-8
      //   em-dash '—'      → 3-byte UTF-8
      //   emoji '🧾' (U+1F9FE) → 4-byte UTF-8 (JS surrogate pair)
      // Codebase policy keeps source ASCII-only; the test still
      // covers the multi-byte paths via punctuation + emoji.
      externalId: 'order-café — receipt 🧾',
    })
    const back = deserializeEvmReceipt(serializeEvmReceipt(r))
    expect(back.externalId).toBe('order-café — receipt 🧾')
  })
})

/* -------------------------------------------------------------------------- */
/*  deserialize negative cases                                                */
/* -------------------------------------------------------------------------- */

describe('deserialize REQUIRED-field guards (draft §7.6)', () => {
  function encode(o: object): string {
    return Buffer.from(JSON.stringify(o)).toString('base64url')
  }

  const FULL = {
    method: 'evm',
    challengeId: 'chal_abc',
    reference: REFERENCE,
    status: 'success',
    timestamp: TIMESTAMP,
    chainId: 97,
  } as const

  test.each(['method', 'challengeId', 'reference', 'status', 'timestamp', 'chainId'] as const)(
    'rejects missing %s',
    (field) => {
      const { [field]: _, ...partial } = FULL
      expect(() => deserializeEvmReceipt(encode(partial))).toThrow(
        new RegExp(`missing required field '${field}'`),
      )
    },
  )

  test('rejects non-object JSON payload (e.g. string)', () => {
    const wire = Buffer.from(JSON.stringify('not-an-object')).toString('base64url')
    expect(() => deserializeEvmReceipt(wire)).toThrow(/expected JSON object/)
  })
})

/* -------------------------------------------------------------------------- */
/*  assertEvmReceipt — single fail-closed guard (v2.28)                       */
/* -------------------------------------------------------------------------- */

describe('assertEvmReceipt fail-closed guard', () => {
  const valid = {
    method: 'evm',
    challengeId: 'chal_abc',
    reference: REFERENCE,
    status: 'success',
    timestamp: TIMESTAMP,
    chainId: 97,
  }

  test('accepts a structurally valid EvmReceipt (no throw)', () => {
    expect(() => assertEvmReceipt(valid)).not.toThrow()
  })

  test('rejects null', () => {
    expect(() => assertEvmReceipt(null)).toThrow(/expected JSON object/)
  })

  test('rejects undefined', () => {
    expect(() => assertEvmReceipt(undefined)).toThrow(/expected JSON object/)
  })

  test('rejects primitive (number)', () => {
    expect(() => assertEvmReceipt(42)).toThrow(/expected JSON object/)
  })

  test("rejects challengeId as number (must be 'string')", () => {
    expect(() => assertEvmReceipt({ ...valid, challengeId: 123 })).toThrow(
      /'challengeId' must be string/,
    )
  })

  test("rejects chainId as string (must be 'number')", () => {
    expect(() => assertEvmReceipt({ ...valid, chainId: '97' })).toThrow(/'chainId' must be number/)
  })

  test.each(['method', 'challengeId', 'reference', 'status', 'timestamp', 'chainId'] as const)(
    'rejects missing required field %s',
    (field) => {
      const { [field]: _, ...partial } = valid
      expect(() => assertEvmReceipt(partial)).toThrow(
        new RegExp(`missing required field '${field}'`),
      )
    },
  )

  // Every required field gets a strict runtime check. Previously
  // only the two type-narrow checks (challengeId / chainId) ran; anything
  // else could slip through and be emitted on the Payment-Receipt header.
  describe('strict per-field value checks', () => {
    test("rejects method = 'tempo' (must be literal 'evm')", () => {
      expect(() => assertEvmReceipt({ ...valid, method: 'tempo' })).toThrow(
        /'method' must be literal 'evm'/,
      )
    })

    test("rejects status = 'failure' (must be literal 'success' — failures use 402)", () => {
      expect(() => assertEvmReceipt({ ...valid, status: 'failure' })).toThrow(
        /'status' must be literal 'success'/,
      )
    })

    test("rejects status = 'pending'", () => {
      expect(() => assertEvmReceipt({ ...valid, status: 'pending' })).toThrow(
        /'status' must be literal 'success'/,
      )
    })

    test('rejects reference as non-string (e.g. number)', () => {
      expect(() => assertEvmReceipt({ ...valid, reference: 123 })).toThrow(
        /'reference' must be 0x-prefixed 32-byte hex tx hash/,
      )
    })

    test('rejects reference shorter than 32 bytes', () => {
      expect(() => assertEvmReceipt({ ...valid, reference: '0xabcdef' })).toThrow(
        /'reference' must be 0x-prefixed 32-byte hex tx hash/,
      )
    })

    test('rejects reference without 0x prefix', () => {
      const noPrefix = REFERENCE.slice(2) // drop the 0x
      expect(() => assertEvmReceipt({ ...valid, reference: noPrefix })).toThrow(
        /'reference' must be 0x-prefixed 32-byte hex tx hash/,
      )
    })

    test('rejects reference with non-hex character', () => {
      // valid length, valid 0x prefix, but contains a 'z'
      const bad = `0x${'z'.repeat(64)}`
      expect(() => assertEvmReceipt({ ...valid, reference: bad })).toThrow(
        /'reference' must be 0x-prefixed 32-byte hex tx hash/,
      )
    })

    test('rejects timestamp as number', () => {
      expect(() => assertEvmReceipt({ ...valid, timestamp: 1738080000 })).toThrow(
        /'timestamp' must be RFC 3339 string/,
      )
    })
  })
})
