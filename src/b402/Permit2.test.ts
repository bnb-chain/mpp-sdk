/**
 * b402 permit2-exact signer + validator (the ADR-0004 security model).
 *
 *   1. buildPermit2ExactPayment signs typed data that recovers to the payer,
 *      against the exact b402 domain/types (no version; Witness{to,validAfter})
 *   2. the SECURITY gates: trustedSpenders required + enforced, non-exact
 *      scheme/method refused, future validAfter refused, deadline capped
 *   3. the wire envelope matches the signing guide (decimal strings, field set)
 *   4. isPermit2PaymentPayload: full-shape + cross-field equalities
 *   5. tampering any signed field breaks recovery (witness binding works)
 */

import { getAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vitest'

import {
  CURATED_B402_SPENDERS,
  buildPermit2ExactPayment,
  isPermit2PaymentPayload,
  recoverPermit2ExactPayer,
} from './Permit2.js'
import type { PaymentRequirements, Permit2PaymentPayload } from './Types.js'

const SPENDER = CURATED_B402_SPENDERS['eip155:97']!.exact
const TRUSTED = [SPENDER]

function permit2Requirements(over: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: 'exact',
    network: 'eip155:97',
    amount: '5000000',
    asset: privateKeyToAccount(generatePrivateKey()).address,
    payTo: privateKeyToAccount(generatePrivateKey()).address,
    maxTimeoutSeconds: 300,
    extra: {
      name: 'USDT Token',
      version: '1',
      assetTransferMethod: 'permit2-exact',
      signerAddress: '0x1111111111111111111111111111111111111111',
      spenderAddress: SPENDER,
    },
    ...over,
  }
}

describe('buildPermit2ExactPayment', () => {
  test('signs typed data that recoverPermit2ExactPayer resolves to the payer', async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const payment = await buildPermit2ExactPayment({
      account,
      requirements: permit2Requirements(),
      trustedSpenders: TRUSTED,
    })
    expect(getAddress(await recoverPermit2ExactPayer(payment))).toBe(account.address)
  })

  test('wire envelope matches the b402 signing guide (decimal strings, exact 1:1 amount)', async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const requirements = permit2Requirements()
    const { payload } = await buildPermit2ExactPayment({
      account,
      requirements,
      trustedSpenders: TRUSTED,
    })
    const auth = payload.permit2Authorization
    expect(auth.permitted.token).toBe(requirements.asset)
    expect(auth.permitted.amount).toBe(requirements.amount) // exact — authorized == settled
    expect(auth.from).toBe(account.address)
    expect(auth.spender).toBe(SPENDER)
    expect(auth.witness.to).toBe(requirements.payTo)
    expect(auth.nonce).toMatch(/^\d+$/)
    expect(auth.deadline).toMatch(/^\d+$/)
    expect(auth.witness.validAfter).toMatch(/^\d+$/)
    expect(payload.signature).toMatch(/^0x[0-9a-f]{130}$/) // strictly 65 bytes
  })

  test('SECURITY: refuses an empty/missing trustedSpenders list', async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    await expect(
      buildPermit2ExactPayment({
        account,
        requirements: permit2Requirements(),
        trustedSpenders: [],
      }),
    ).rejects.toThrow(/trustedSpenders is required/)
  })

  test('SECURITY: refuses a spender outside the allowlist (the phishing anchor)', async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const hostile = permit2Requirements({
      extra: {
        ...permit2Requirements().extra,
        spenderAddress: '0x9999999999999999999999999999999999999999',
      },
    })
    await expect(
      buildPermit2ExactPayment({ account, requirements: hostile, trustedSpenders: TRUSTED }),
    ).rejects.toThrow(/not in trustedSpenders/)
  })

  test('refuses non-exact scheme and non-permit2-exact method (upto is out of scope)', async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    await expect(
      buildPermit2ExactPayment({
        account,
        requirements: permit2Requirements({ scheme: 'upto' }),
        trustedSpenders: TRUSTED,
      }),
    ).rejects.toThrow(/only 'exact'/)
    const upto = permit2Requirements()
    await expect(
      buildPermit2ExactPayment({
        account,
        requirements: {
          ...upto,
          extra: { ...upto.extra, assetTransferMethod: 'permit2-upto' },
        },
        trustedSpenders: TRUSTED,
      }),
    ).rejects.toThrow(/not 'permit2-exact'/)
  })

  test('refuses a future validAfter and an over-long deadline', async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const now = Math.floor(Date.now() / 1000)
    await expect(
      buildPermit2ExactPayment({
        account,
        requirements: permit2Requirements(),
        trustedSpenders: TRUSTED,
        validAfter: String(now + 3600),
      }),
    ).rejects.toThrow(/validAfter .* future/)
    await expect(
      buildPermit2ExactPayment({
        account,
        requirements: permit2Requirements(),
        trustedSpenders: TRUSTED,
        deadline: String(now + 24 * 3600), // way past the cap
      }),
    ).rejects.toThrow(/exceeds the cap/)
  })

  test('tampering the witness recipient breaks recovery (the binding works)', async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const payment = await buildPermit2ExactPayment({
      account,
      requirements: permit2Requirements(),
      trustedSpenders: TRUSTED,
    })
    const tampered: Permit2PaymentPayload = {
      ...payment,
      payload: {
        ...payment.payload,
        permit2Authorization: {
          ...payment.payload.permit2Authorization,
          witness: {
            ...payment.payload.permit2Authorization.witness,
            to: '0x9999999999999999999999999999999999999999',
          },
        },
      },
    }
    expect(getAddress(await recoverPermit2ExactPayer(tampered))).not.toBe(account.address)
  })
})

describe('isPermit2PaymentPayload', () => {
  async function good(): Promise<Permit2PaymentPayload> {
    const account = privateKeyToAccount(generatePrivateKey())
    return buildPermit2ExactPayment({
      account,
      requirements: permit2Requirements(),
      trustedSpenders: TRUSTED,
    })
  }

  test('accepts a built payload', async () => {
    expect(isPermit2PaymentPayload(await good())).toBe(true)
  })

  test('rejects envelope/shape violations', async () => {
    const g = await good()
    expect(isPermit2PaymentPayload(null)).toBe(false)
    expect(isPermit2PaymentPayload({})).toBe(false)
    expect(isPermit2PaymentPayload({ ...g, x402Version: 1 })).toBe(false)
    expect(isPermit2PaymentPayload({ ...g, accepted: { ...g.accepted, scheme: 'upto' } })).toBe(
      false,
    )
    expect(
      isPermit2PaymentPayload({
        ...g,
        accepted: {
          ...g.accepted,
          extra: { ...g.accepted.extra, assetTransferMethod: 'eip3009' },
        },
      }),
    ).toBe(false)
    // an eip3009-shaped payload body must NOT pass the permit2 guard
    expect(
      isPermit2PaymentPayload({
        ...g,
        payload: { signature: g.payload.signature, authorization: {} },
      }),
    ).toBe(false)
  })

  test('rejects cross-field mismatches a facilitator would reject anyway', async () => {
    const g = await good()
    const withAuth = (over: Record<string, unknown>): unknown => ({
      ...g,
      payload: {
        ...g.payload,
        permit2Authorization: { ...g.payload.permit2Authorization, ...over },
      },
    })
    // spender ≠ extra.spenderAddress
    expect(
      isPermit2PaymentPayload(withAuth({ spender: '0x9999999999999999999999999999999999999999' })),
    ).toBe(false)
    // witness.to ≠ payTo
    expect(
      isPermit2PaymentPayload(
        withAuth({
          witness: {
            ...g.payload.permit2Authorization.witness,
            to: '0x9999999999999999999999999999999999999999',
          },
        }),
      ),
    ).toBe(false)
    // permitted.amount ≠ accepted.amount
    expect(
      isPermit2PaymentPayload(
        withAuth({
          permitted: { ...g.payload.permit2Authorization.permitted, amount: '1' },
        }),
      ),
    ).toBe(false)
  })
})
