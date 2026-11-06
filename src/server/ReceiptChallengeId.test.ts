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
describe('receipt challenge association', () => {
  test.each(['', ' ', '\t\n'])('rejects empty or whitespace-only challengeId', (challengeId) => {
    const receipt = { ...valid, challengeId }
    expect(() => assertEvmReceipt(receipt)).toThrow(/challengeId/)
    expect(() => deserializeEvmReceipt(encoded(receipt))).toThrow(/challengeId/)
    expect(() => serializeEvmReceipt(receipt as never)).toThrow(/challengeId/)
  })
  test('preserves a non-empty challenge association', () => {
    expect(deserializeEvmReceipt(encoded(valid)).challengeId).toBe(valid.challengeId)
  })
})
