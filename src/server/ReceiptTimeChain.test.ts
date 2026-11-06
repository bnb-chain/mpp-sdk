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
describe('receipt timestamp and chain claims', () => {
  test.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid chainId %s',
    (chainId) => {
      expect(() => assertEvmReceipt({ ...valid, chainId })).toThrow(/chainId/)
      expect(() => deserializeEvmReceipt(encoded({ ...valid, chainId }))).toThrow(/chainId/)
    },
  )
  test.each(['garbage', '2026-02-30T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01'])(
    'rejects invalid timestamp %s',
    (timestamp) => {
      expect(() => assertEvmReceipt({ ...valid, timestamp })).toThrow(/timestamp/)
      expect(() => serializeEvmReceipt({ ...valid, timestamp } as never)).toThrow(/timestamp/)
    },
  )
  test('preserves valid RFC3339 offsets and fractional seconds', () => {
    const receipt = { ...valid, timestamp: '2024-02-29T23:59:59.123-05:00' }
    expect(deserializeEvmReceipt(encoded(receipt)).timestamp).toBe(receipt.timestamp)
  })
})
