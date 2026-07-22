/**
 * b402 "Tesla" request signing (the security-critical, pure part of B402Client).
 *
 *   1. signTeslaRequest / verifyTeslaSignature round-trip; tampering fails
 *   2. the signed canonical string is exactly `body + timestamp`
 *   3. loadRsaPrivateKey accepts Base64-DER-PKCS#8, Base64-PEM, and raw PEM
 *
 * Provider flows are exercised through the server payment Method and standard
 * facilitator Adapter tests; here we pin the signing primitive that
 * authenticates to B402.
 */

import { createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto'

import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  B402Client,
  B402Error,
  loadRsaPrivateKey,
  signTeslaRequest,
  verifyTeslaSignature,
} from './Client.js'

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

describe('B402Client constructor', () => {
  const creds = { baseUrl: 'https://example.test', clientId: 'cid', accessToken: 'tok' }

  test('parses the RSA key EAGERLY — a malformed key fails at construction with a format hint', () => {
    // Before: a bad key surfaced only at the FIRST paid request (after the
    // buyer already signed) as a bare node:crypto error.
    expect(() => new B402Client({ ...creds, privateKey: '0xdeadbeef' })).toThrowError(B402Error)
    expect(() => new B402Client({ ...creds, privateKey: 'not-a-key' })).toThrow(
      /could not parse `privateKey`.*Base64 PKCS#8 DER/,
    )
  })

  test('accepts all three documented key forms', () => {
    const { derB64, pem } = keypair()
    const pemB64 = Buffer.from(pem, 'utf8').toString('base64')
    for (const form of [derB64, pemB64, pem]) {
      expect(() => new B402Client({ ...creds, privateKey: form })).not.toThrow()
    }
  })
})

describe('B402Client response boundary', () => {
  afterEach(() => vi.unstubAllGlobals())

  test('wraps malformed success data in a B402Error before returning it to callers', async () => {
    const { derB64 } = keypair()
    const client = new B402Client({
      baseUrl: 'https://example.test',
      clientId: 'cid',
      accessToken: 'tok',
      privateKey: derB64,
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: '000000',
              data: {
                success: true,
                transaction: `0x${'ab'.repeat(32)}`,
                payer: 'not-an-address',
                network: 'eip155:56',
                amount: 1,
              },
            }),
            { status: 200 },
          ),
      ),
    )

    await expect(
      client.settle({
        x402Version: 2,
        paymentPayload: {} as never,
        paymentRequirements: {} as never,
      }),
    ).rejects.toMatchObject({
      name: 'B402Error',
      message: expect.stringMatching(
        /malformed success data.*payer|malformed success data.*amount/,
      ),
    })
  })
})

describe('B402Client.fromEnv', () => {
  const full = () => ({
    B402_BASE_URL: 'https://example.test',
    B402_CLIENT_ID: 'cid',
    B402_ACCESS_TOKEN: 'tok',
    B402_PRIVATE_KEY: keypair().derB64,
  })

  test('all four unset → undefined (b402 simply not configured)', () => {
    expect(B402Client.fromEnv({})).toBeUndefined()
    expect(B402Client.fromEnv({ UNRELATED: 'x' })).toBeUndefined()
  })

  test('all four set → a working client', () => {
    expect(B402Client.fromEnv(full())).toBeInstanceOf(B402Client)
  })

  test('accepts B402_PRIVATE_KEY_B64 as the key variable', () => {
    const { B402_PRIVATE_KEY, ...rest } = full()
    expect(B402Client.fromEnv({ ...rest, B402_PRIVATE_KEY_B64: B402_PRIVATE_KEY })).toBeInstanceOf(
      B402Client,
    )
  })

  test('SECURITY: a partial config fails LOUDLY, naming the missing vars', () => {
    // Silently proceeding without b402 would swap the settlement semantics
    // behind the operator's back — a typo'd var name must not boot.
    const { B402_ACCESS_TOKEN: _, ...partial } = full()
    expect(() => B402Client.fromEnv(partial)).toThrowError(B402Error)
    expect(() => B402Client.fromEnv(partial)).toThrow(/missing B402_ACCESS_TOKEN/)
    expect(() => B402Client.fromEnv({ B402_BASE_URL: 'https://x' })).toThrow(
      /B402_CLIENT_ID.*B402_ACCESS_TOKEN.*B402_PRIVATE_KEY/,
    )
  })
})
