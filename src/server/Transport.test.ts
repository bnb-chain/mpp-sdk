/**
 * evmHttpTransport invariants (spec §13.4.1 path C2, v2.28 fail-closed).
 *
 * Confirms:
 *   - respondReceipt encodes via serializeEvmReceipt for EvmReceipt inputs
 *     → all draft §7.6 fields round-trip from the Payment-Receipt header
 *   - Fail-closed: non-EVM receipts (or EVM receipts missing draft §7.6
 *     fields) throw immediately rather than silently falling back to mppx's
 *     default Receipt.serialize (which strips challengeId / chainId)
 *   - other Transport.http behaviors (captureRequest, getCredential,
 *     respondChallenge) are inherited unchanged
 */

import { Receipt } from 'mppx'
import { describe, expect, test } from 'vitest'

import { buildEvmReceipt, deserializeEvmReceipt } from './Receipt.js'
import { evmHttpTransport } from './Transport.js'

const REFERENCE = '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789' as const
const TIMESTAMP = '2026-05-28T01:00:00Z'

const evmReceipt = () =>
  buildEvmReceipt({
    method: 'evm',
    status: 'success',
    challengeId: 'chal_abc',
    reference: REFERENCE,
    timestamp: TIMESTAMP,
    chainId: 97,
    externalId: 'order-42',
  })

describe('evmHttpTransport.respondReceipt encodes EvmReceipt via SDK codec', () => {
  test('Payment-Receipt header round-trips all draft §7.6 fields', () => {
    const transport = evmHttpTransport()
    const base = new Response('OK', { status: 200 })

    const out = transport.respondReceipt({
      challengeId: 'chal_abc',
      credential: { challenge: {} as never, payload: {} },
      input: new Request('https://test.example/'),
      receipt: evmReceipt(),
      response: base,
    })

    const header = (out as Response).headers.get('Payment-Receipt')
    expect(header).toBeTruthy()

    const decoded = deserializeEvmReceipt(header!)
    expect(decoded).toMatchObject({
      method: 'evm',
      status: 'success',
      challengeId: 'chal_abc',
      reference: REFERENCE,
      timestamp: TIMESTAMP,
      chainId: 97,
      externalId: 'order-42',
    })
  })

  test('preserves response body + status', () => {
    const transport = evmHttpTransport()
    const base = new Response('hello world', { status: 200 })

    const out = transport.respondReceipt({
      challengeId: 'chal_abc',
      credential: { challenge: {} as never, payload: {} },
      input: new Request('https://test.example/'),
      receipt: evmReceipt(),
      response: base,
    }) as Response

    expect(out.status).toBe(200)
    // Body Streams in fetch land are one-shot; clone to inspect.
    return out.text().then((body) => {
      expect(body).toBe('hello world')
    })
  })
})

describe('evmHttpTransport.respondReceipt is fail-closed for non-EVM-Charge receipts (v2.28)', () => {
  test('throws when receipt is a generic mppx Receipt missing draft §7.6 fields', () => {
    const transport = evmHttpTransport()
    // tempo Receipt.from output has only mppx generic schema fields —
    // no challengeId, no chainId. Previously the transport silently
    // fell back to Receipt.serialize; v2.28 makes that fail-closed.
    const tempoReceipt = Receipt.from({
      method: 'tempo',
      reference: REFERENCE,
      status: 'success',
      timestamp: TIMESTAMP,
    })
    const base = new Response('OK', { status: 200 })

    expect(() =>
      transport.respondReceipt({
        challengeId: 'chal_abc',
        credential: { challenge: {} as never, payload: {} },
        input: new Request('https://test.example/'),
        receipt: tempoReceipt,
        response: base,
      }),
    ).toThrow(/missing required field 'challengeId'/)
  })

  test('throws when EVM receipt has wrong type for chainId', () => {
    const transport = evmHttpTransport()
    // Hand-construct a receipt with all fields present but chainId as
    // a string — the kind of bug that's easy to miss without the strict
    // type check in assertEvmReceipt.
    const malformed = {
      method: 'evm',
      status: 'success',
      challengeId: 'chal_abc',
      reference: REFERENCE,
      timestamp: TIMESTAMP,
      chainId: '97', // wrong: should be number
    } as unknown as ReturnType<typeof buildEvmReceipt>
    const base = new Response('OK', { status: 200 })

    expect(() =>
      transport.respondReceipt({
        challengeId: 'chal_abc',
        credential: { challenge: {} as never, payload: {} },
        input: new Request('https://test.example/'),
        receipt: malformed,
        response: base,
      }),
    ).toThrow(/'chainId' must be number/)
  })

  // Transport-level negative cases for the newly-tightened
  // assertEvmReceipt checks. These are the failure modes that previously
  // could slip onto the Payment-Receipt header because assertEvmReceipt
  // only validated challengeId/chainId types.
  test('throws when method is not literal "evm"', () => {
    const transport = evmHttpTransport()
    const wrong = {
      method: 'tempo',
      status: 'success',
      challengeId: 'chal_abc',
      reference: REFERENCE,
      timestamp: TIMESTAMP,
      chainId: 97,
    } as unknown as ReturnType<typeof buildEvmReceipt>
    expect(() =>
      transport.respondReceipt({
        challengeId: 'chal_abc',
        credential: { challenge: {} as never, payload: {} },
        input: new Request('https://test.example/'),
        receipt: wrong,
        response: new Response('OK', { status: 200 }),
      }),
    ).toThrow(/'method' must be literal 'evm'/)
  })

  test('throws when status is not literal "success" (e.g. failure)', () => {
    const transport = evmHttpTransport()
    const wrong = {
      method: 'evm',
      status: 'failure',
      challengeId: 'chal_abc',
      reference: REFERENCE,
      timestamp: TIMESTAMP,
      chainId: 97,
    } as unknown as ReturnType<typeof buildEvmReceipt>
    expect(() =>
      transport.respondReceipt({
        challengeId: 'chal_abc',
        credential: { challenge: {} as never, payload: {} },
        input: new Request('https://test.example/'),
        receipt: wrong,
        response: new Response('OK', { status: 200 }),
      }),
    ).toThrow(/'status' must be literal 'success'/)
  })

  test('throws when reference is not 0x-prefixed 32-byte hex', () => {
    const transport = evmHttpTransport()
    const wrong = {
      method: 'evm',
      status: 'success',
      challengeId: 'chal_abc',
      reference: 'not-a-hash',
      timestamp: TIMESTAMP,
      chainId: 97,
    } as unknown as ReturnType<typeof buildEvmReceipt>
    expect(() =>
      transport.respondReceipt({
        challengeId: 'chal_abc',
        credential: { challenge: {} as never, payload: {} },
        input: new Request('https://test.example/'),
        receipt: wrong,
        response: new Response('OK', { status: 200 }),
      }),
    ).toThrow(/'reference' must be 0x-prefixed 32-byte hex/)
  })

  test('throws when timestamp is a number instead of RFC 3339 string', () => {
    const transport = evmHttpTransport()
    const wrong = {
      method: 'evm',
      status: 'success',
      challengeId: 'chal_abc',
      reference: REFERENCE,
      timestamp: 1738080000,
      chainId: 97,
    } as unknown as ReturnType<typeof buildEvmReceipt>
    expect(() =>
      transport.respondReceipt({
        challengeId: 'chal_abc',
        credential: { challenge: {} as never, payload: {} },
        input: new Request('https://test.example/'),
        receipt: wrong,
        response: new Response('OK', { status: 200 }),
      }),
    ).toThrow(/'timestamp' must be RFC 3339 string/)
  })
})

describe('evmHttpTransport inherits other Transport.http behaviors', () => {
  test('name reflects evm-http (so logs/debug tooling can distinguish)', () => {
    const transport = evmHttpTransport()
    expect(transport.name).toBe('evm-http')
  })

  test('getCredential reads the Authorization: Payment header', () => {
    const transport = evmHttpTransport()
    // No Authorization header => null
    const req = new Request('https://test.example/')
    expect(transport.getCredential(req)).toBeNull()
  })
})
