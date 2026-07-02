/**
 * b402ChargeParams — the one-call "mode 3" ServerParameters assembly.
 * Shape-level tests: the wiring IS the contract (credentialTypes narrowed to
 * authorization, a B402Adapter settle backend, curated $U default).
 */

import { generateKeyPairSync } from 'node:crypto'

import { describe, expect, test } from 'vitest'

import { B402Client } from '../Client.js'
import { B402Adapter, b402ChargeParams } from './index.js'

function client(): B402Client {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return new B402Client({
    baseUrl: 'https://example.test',
    clientId: 'cid',
    accessToken: 'tok',
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  })
}

const RECIPIENT = '0x2222222222222222222222222222222222222222' as const

describe('b402ChargeParams', () => {
  test('assembles the full mode-3 wiring with safe defaults', () => {
    const params = b402ChargeParams({ client: client(), chain: 'bsc', recipient: RECIPIENT })
    expect(params.chain).toBe('bsc')
    expect(params.token).toBe('U')
    expect(params.recipient).toBe(RECIPIENT)
    expect(params.challengeBinding).toEqual({ mode: 'mppx-managed' })
    // authorization ONLY — no local signer exists for permit2/transaction/hash.
    expect(params.credentialTypes).toEqual(['authorization'])
    expect(params.settleBackend).toBeInstanceOf(B402Adapter)
    // No stray rpcUrl key when not requested (spread-friendliness).
    expect('rpcUrl' in params).toBe(false)
  })

  test('passes through token / rpcUrl / challengeBinding overrides', () => {
    const params = b402ChargeParams({
      client: client(),
      chain: 'bsc-testnet',
      recipient: RECIPIENT,
      token: 'U',
      rpcUrl: 'https://rpc.example',
      challengeBinding: { mode: 'mppx-hmac', secretKey: 's' },
    })
    expect(params.chain).toBe('bsc-testnet')
    expect(params.rpcUrl).toBe('https://rpc.example')
    expect(params.challengeBinding).toEqual({ mode: 'mppx-hmac', secretKey: 's' })
  })

  test('is spread-friendly — callers can extend without fighting the helper', () => {
    const params = {
      ...b402ChargeParams({ client: client(), chain: 'bsc', recipient: RECIPIENT }),
      amount: '10',
    }
    expect(params.amount).toBe('10')
    expect(params.credentialTypes).toEqual(['authorization'])
  })
})
