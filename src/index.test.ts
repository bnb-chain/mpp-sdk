/**
 * chargeFromDecimal invariants (spec §6.5 Option A — PR1 only).
 *
 *   - parses decimal strings into base-units integers per `decimals`
 *   - rejects splits at runtime (the type-level `never` guard is a hint;
 *     the runtime check is the safety net)
 *   - rejects methodDetails at runtime
 *   - preserves recipient / description / externalId when provided
 *   - omits optional keys when not provided (deterministic output for
 *     downstream JSON serialization)
 */

import { describe, expect, test } from 'vitest'

import { chargeFromDecimal } from './index.js'

const RECIPIENT = '0x2222222222222222222222222222222222222222' as const

describe('chargeFromDecimal — decimal -> base-units', () => {
  test('"1.23" with decimals 6 -> "1230000"', () => {
    expect(chargeFromDecimal({ amount: '1.23', decimals: 6 }).amount).toBe('1230000')
  })

  test('"1" with decimals 18 -> "1000000000000000000"', () => {
    expect(chargeFromDecimal({ amount: '1', decimals: 18 }).amount).toBe('1000000000000000000')
  })

  test('numeric input is coerced via String()', () => {
    expect(chargeFromDecimal({ amount: 2.5, decimals: 6 }).amount).toBe('2500000')
  })

  test('passes recipient/description/externalId through', () => {
    const out = chargeFromDecimal({
      amount: '1',
      decimals: 6,
      recipient: RECIPIENT,
      description: 'invoice 42',
      externalId: 'ord-42',
    })
    expect(out.recipient).toBe(RECIPIENT)
    expect(out.description).toBe('invoice 42')
    expect(out.externalId).toBe('ord-42')
  })

  test('omits optional keys when not provided (no `undefined` properties)', () => {
    const out = chargeFromDecimal({ amount: '1', decimals: 6 })
    expect(out).not.toHaveProperty('recipient')
    expect(out).not.toHaveProperty('description')
    expect(out).not.toHaveProperty('externalId')
  })
})

describe('chargeFromDecimal — runtime guards', () => {
  test('rejects splits at runtime even if type system is bypassed', () => {
    expect(() =>
      chargeFromDecimal({
        amount: '1',
        decimals: 6,
        // Force the `never` type system rule to be bypassed.
        splits: [{ recipient: RECIPIENT, amount: '500000' }],
      } as unknown as Parameters<typeof chargeFromDecimal>[0]),
    ).toThrow(/splits/i)
  })

  test('rejects methodDetails at runtime', () => {
    expect(() =>
      chargeFromDecimal({
        amount: '1',
        decimals: 6,
        methodDetails: { chainId: 1 },
      } as unknown as Parameters<typeof chargeFromDecimal>[0]),
    ).toThrow(/methodDetails/i)
  })
})
