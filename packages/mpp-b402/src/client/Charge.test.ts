import { B402_PERMIT2_ADDRESS, CURATED_B402_SPENDERS } from '@bnb-chain/b402'
import { Challenge, Credential, evm } from 'mppx'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vitest'

import {
  chargeMethod,
  type B402ChargeCredentialPayload,
  type B402ChargeRequest,
  type B402ChargeTransferMethod,
} from '../Methods.js'
import { charge } from './Charge.js'

const NETWORK = 'eip155:97' as const
const CURRENCY = '0x337610d27c682E347C9cD60BD4b3b107C9d34dDd' as const
const RECIPIENT = '0x2222222222222222222222222222222222222222' as const
const SIGNER = '0x1111111111111111111111111111111111111111' as const
const SPENDER = CURATED_B402_SPENDERS[NETWORK]!.exact

function challenge(transferMethod: B402ChargeTransferMethod) {
  return Challenge.fromMethod(chargeMethod, {
    expires: new Date(Date.now() + 5 * 60_000).toISOString(),
    realm: 'merchant.example',
    request: {
      amount: '5',
      currency: CURRENCY,
      decimals: 6,
      maxTimeoutSeconds: 300,
      network: NETWORK,
      providerSnapshot: {
        signerAddress: SIGNER,
        ...(transferMethod === 'permit2-exact' ? { spenderAddress: SPENDER } : {}),
      },
      recipient: RECIPIENT,
      tokenName: 'USDT Token',
      tokenVersion: '1',
      transferMethod,
    },
    secretKey: 'test-secret-key-that-is-at-least-32-bytes',
  }) as Challenge.Challenge<B402ChargeRequest, 'charge', 'b402'>
}

describe('b402 client charge', () => {
  test('binds EIP-3009 authorization nonce to the MPP Challenge', async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const issued = challenge('eip3009')
    const client = charge({ account, allowedNetworks: [NETWORK], maxAmount: '10' })

    const credential = Credential.deserialize<B402ChargeCredentialPayload>(
      await client.createCredential({ challenge: issued }),
    )
    expect(credential.payload).toMatchObject({
      type: 'eip3009',
      authorization: {
        nonce: evm.Types.challengeHash(issued),
        to: RECIPIENT,
        value: '5000000',
      },
    })
    if (credential.payload.type !== 'eip3009') throw new Error('expected EIP-3009 credential')
    expect(BigInt(credential.payload.authorization.validBefore)).toBeLessThanOrEqual(
      BigInt(Math.floor(new Date(issued.expires!).getTime() / 1000)),
    )
  })

  test('binds Permit2 unordered nonce and requires allowance plus trusted spender', async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const issued = challenge('permit2-exact')
    const client = charge({
      account,
      permit2Allowance: async (query) => {
        expect(query.spender).toBe(B402_PERMIT2_ADDRESS)
        return 5_000_000n
      },
      trustedSpenders: { [NETWORK]: [SPENDER] },
    })

    const credential = Credential.deserialize<B402ChargeCredentialPayload>(
      await client.createCredential({ challenge: issued }),
    )
    expect(credential.payload).toMatchObject({
      type: 'permit2-exact',
      permit2Authorization: {
        nonce: BigInt(evm.Types.challengeHash(issued)).toString(),
        spender: SPENDER,
        witness: { to: RECIPIENT },
      },
    })
    if (credential.payload.type !== 'permit2-exact') throw new Error('expected Permit2 credential')
    expect(BigInt(credential.payload.permit2Authorization.deadline)).toBeLessThanOrEqual(
      BigInt(Math.floor(new Date(issued.expires!).getTime() / 1000)),
    )
  })

  test('falls back behind EIP-3009 when Permit2 allowance is missing', async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const client = charge({
      account,
      permit2Allowance: () => Promise.resolve(0n),
      trustedSpenders: { [NETWORK]: [SPENDER] },
    })
    const permit2 = { challenge: challenge('permit2-exact'), method: client }
    const eip3009 = { challenge: challenge('eip3009'), method: client }

    const ordered = await client.prefer(['permit2-exact', 'eip3009'], {
      onMissingAllowance: 'fallback',
    })([permit2, eip3009])
    expect(
      ordered.map((candidate) => candidate.challenge.request.methodDetails.assetTransferMethod),
    ).toEqual(['eip3009', 'permit2-exact'])
  })

  test('does not disguise an allowance-read failure as a missing allowance', async () => {
    const client = charge({
      account: privateKeyToAccount(generatePrivateKey()),
      permit2Allowance: () => Promise.reject(new Error('RPC unavailable')),
      trustedSpenders: { [NETWORK]: [SPENDER] },
    })
    const permit2 = { challenge: challenge('permit2-exact'), method: client }
    const eip3009 = { challenge: challenge('eip3009'), method: client }

    await expect(
      client.prefer(['permit2-exact', 'eip3009'], { onMissingAllowance: 'fallback' })([
        permit2,
        eip3009,
      ]),
    ).rejects.toThrow(/RPC unavailable/)
  })
})
