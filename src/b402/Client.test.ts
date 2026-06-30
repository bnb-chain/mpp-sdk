/**
 * b402 "Tesla" request signing (the security-critical, pure part of B402Client).
 *
 *   1. signTeslaRequest / verifyTeslaSignature round-trip; tampering fails
 *   2. the signed canonical string is exactly `body + timestamp`
 *   3. loadRsaPrivateKey accepts Base64-DER-PKCS#8, Base64-PEM, and raw PEM
 *
 * The /supported · /settle flow is exercised end-to-end through `B402Adapter`
 * (against a fake B402Client) in src/b402/mppx/Adapter.test.ts; here we pin the
 * signing primitive that authenticates to b402.
 */

import { createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto'

import { describe, expect, test } from 'vitest'

import { loadRsaPrivateKey, signTeslaRequest, verifyTeslaSignature } from './Client.js'

function keypair(): { publicKey: KeyObject; derB64: string; pem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return {
    publicKey,
    derB64: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    pem: privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
  }
}

describe('Tesla signing', () => {
  test('round-trips and rejects tampering', () => {
    const { publicKey, derB64 } = keypair()
    const body = '{"x402Version":2}'
    const timestamp = '1710000000000'

    const signature = signTeslaRequest(derB64, body, timestamp)
    expect(verifyTeslaSignature(publicKey, body, timestamp, signature)).toBe(true)

    // A different body or timestamp must not verify.
    expect(verifyTeslaSignature(publicKey, body, '1710000000001', signature)).toBe(false)
    expect(verifyTeslaSignature(publicKey, '{}', timestamp, signature)).toBe(false)
  })

  test('signs exactly `body + timestamp` (concatenation, that order)', () => {
    const { publicKey, derB64 } = keypair()
    const signature = signTeslaRequest(derB64, '{}', '123')
    // Same concatenated bytes, split differently → identical, so verifies.
    expect(verifyTeslaSignature(publicKey, '{}', '123', signature)).toBe(true)
    expect(verifyTeslaSignature(publicKey, '{}1', '23', signature)).toBe(true)
    // Reversed order → different bytes → does not verify.
    expect(verifyTeslaSignature(publicKey, '123', '{}', signature)).toBe(false)
  })
})

describe('loadRsaPrivateKey', () => {
  test('accepts Base64-DER-PKCS#8, Base64-PEM, and raw PEM forms', () => {
    const { publicKey, derB64, pem } = keypair()
    const pemB64 = Buffer.from(pem, 'utf8').toString('base64')

    for (const form of [derB64, pemB64, pem]) {
      // Each form must produce a usable signer for the same public key.
      const signature = signTeslaRequest(form, 'body', 'ts')
      expect(verifyTeslaSignature(publicKey, 'body', 'ts', signature)).toBe(true)
      // And load to an asymmetric private key.
      const key = loadRsaPrivateKey(form)
      expect(key.asymmetricKeyType).toBe('rsa')
      // Sanity: a public key can be derived from it.
      expect(createPublicKey(key).asymmetricKeyType).toBe('rsa')
    }
  })
})
