import { describe, expect, test } from 'vitest'

import { assertEvmReceipt, deserializeEvmReceipt, serializeEvmReceipt } from './Receipt.js'
const valid = {
  method: 'evm',
  status: 'success',
  challengeId: 'order-A',
  reference: `0x${'12'.repeat(32)}`,
  timestamp: '2026-02-28T12:00:00Z',
  chainId: 56,
} as const
function encoded(receipt: unknown): string {
  return Buffer.from(JSON.stringify(receipt)).toString('base64url')
}
describe('optional receipt externalId', () => {
  test('accepts absent and string externalId values', () => {
    expect(() => assertEvmReceipt(valid)).not.toThrow()
    const receipt = { ...valid, externalId: 'merchant-order' }
    expect(deserializeEvmReceipt(encoded(receipt)).externalId).toBe('merchant-order')
  })
  test.each([null, 42, false, {}, []])(
    'rejects non-string externalId at inbound and outbound boundaries',
    (externalId) => {
      const receipt = { ...valid, externalId }
      expect(() => assertEvmReceipt(receipt)).toThrow(/externalId/)
      expect(() => deserializeEvmReceipt(encoded(receipt))).toThrow(/externalId/)
      expect(() => serializeEvmReceipt(receipt as never)).toThrow(/externalId/)
    },
  )
})
