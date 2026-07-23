import { Credential, Method, Receipt, z } from 'mppx'
import { Mppx } from 'mppx/server'
import { describe, expect, test } from 'vitest'

import { chargeMethod } from '../../src/Methods.js'

const contractMethod = Method.from({
  name: 'mppx-contract',
  intent: 'charge',
  schema: {
    credential: {
      payload: z.object({ type: z.literal('contract-proof') }),
    },
    request: z.object({ amount: z.string() }),
  },
})

function contractServer() {
  let verifyCalls = 0
  const method = Method.toServer(contractMethod, {
    async verify({ credential }) {
      verifyCalls += 1
      return Receipt.from({
        challengeId: credential.challenge.id,
        method: contractMethod.name,
        reference: 'contract-test',
        status: 'success',
        timestamp: new Date().toISOString(),
      })
    },
  })
  const server = Mppx.create({
    methods: [method],
    realm: 'contract.example',
    secretKey: 'mppx-contract-secret-key-at-least-32-bytes',
  })
  return { server, verifyCalls: () => verifyCalls }
}

describe('pinned mppx behavior contract', () => {
  test('mppx z.amount still accepts decimals while evm/charge keeps base-unit integers', () => {
    expect(() => z.amount().parse('1.5')).not.toThrow()
    expect(() =>
      chargeMethod.schema.request.parse({
        amount: '1.5',
        currency: '0x1111111111111111111111111111111111111111',
        methodDetails: {
          chainId: 56,
          permit2Address: '0x000000000022d473030f116ddee9f6b43ac78ba3',
        },
        recipient: '0x2222222222222222222222222222222222222222',
      }),
    ).toThrow(/amount/i)
  })

  test('Mppx.create rejects an expired challenge before Method.verify', async () => {
    const fixture = contractServer()
    const challenge = await fixture.server.challenge['mppx-contract'].charge({
      amount: '1',
      expires: new Date(Date.now() - 60_000),
    })
    const credential = Credential.serialize(
      Credential.from({ challenge, payload: { type: 'contract-proof' } }),
    )

    await expect(
      fixture.server.verifyCredential(credential, { request: { amount: '1' } }),
    ).rejects.toThrow(/expired/i)
    expect(fixture.verifyCalls()).toBe(0)
  })

  test('Mppx.create rejects HMAC-bound request drift before Method.verify', async () => {
    const fixture = contractServer()
    const challenge = await fixture.server.challenge['mppx-contract'].charge({ amount: '1' })
    const tampered = {
      ...challenge,
      request: { ...challenge.request, amount: '2' },
    }
    const credential = Credential.serialize(
      Credential.from({ challenge: tampered, payload: { type: 'contract-proof' } }),
    )

    await expect(
      fixture.server.verifyCredential(credential, { request: { amount: '2' } }),
    ).rejects.toThrow()
    expect(fixture.verifyCalls()).toBe(0)
  })
})
