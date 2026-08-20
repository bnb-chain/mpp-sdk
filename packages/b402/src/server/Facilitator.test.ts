/**
 * B402FacilitatorClient payment reconstruction — the smart-account
 * (ERC-1271/ERC-7739) permit2 branch and the EOA recover-and-compare
 * regressions.
 *
 * A smart-account permit2 signature (longer than 65 bytes) has no
 * recoverable key: only the payer contract's `isValidSignature()` can
 * validate it, which the B402 facilitator performs on-chain at `/verify` and
 * `/settle` (live on the permit2 rails since 2026-08). The client must
 * therefore forward such payments instead of rejecting them locally — while
 * keeping every local guard for EOA signatures and for the eip3009 rail
 * (which the facilitator only accepts EOA signatures on).
 */
import type {
  PaymentPayload as X402PaymentPayload,
  PaymentRequirements as X402PaymentRequirements,
} from '@x402/core/types'
import { getAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vitest'

import { buildEip3009Payment } from '../Payload.js'
import { buildPermit2ExactPayment } from '../Permit2.js'
import type { PaymentRequirements, SupportedResponse } from '../Types.js'
import { B402FacilitatorClient } from './Facilitator.js'
import type { B402ReplayChange, B402ReplayStore } from './Replay.js'
import type { B402Transport } from './Types.js'

const network = 'eip155:97' as const
const asset = getAddress('0x337610d27c682e347c9cd60bd4b3b107c9d34ddd')
const payTo = getAddress('0x6ce211911aef93bae0e01e8aeb053654558b0aec')
const providerSigner = '0x5f77eE41BaffDAe61830eF9be76541444FAE5D11' as const
const spender = '0x45481A7FaFc1e62Bb7D851645927E32a2FFA0271' as const
const transaction = `0x${'ab'.repeat(32)}`
const SMART_SIGNATURE = `0x${'cd'.repeat(98)}` as const

/** The b402 wire types are structurally the official x402 core types; the
 * client's public surface takes the core names. */
const asX402 = (payload: unknown): X402PaymentPayload => payload as X402PaymentPayload
const asX402Requirements = (requirements: unknown): X402PaymentRequirements =>
  requirements as X402PaymentRequirements

function permit2Requirements(): PaymentRequirements {
  return {
    scheme: 'exact',
    network,
    amount: '1000',
    asset,
    payTo,
    maxTimeoutSeconds: 300,
    extra: {
      name: 'USDT Token',
      version: '1',
      assetTransferMethod: 'permit2-exact',
      signerAddress: providerSigner,
      spenderAddress: spender,
    },
  }
}

function eip3009Requirements(): PaymentRequirements {
  return {
    scheme: 'exact',
    network,
    amount: '1000',
    asset,
    payTo,
    maxTimeoutSeconds: 300,
    extra: {
      name: 'U',
      version: '1',
      assetTransferMethod: 'eip3009',
      signerAddress: providerSigner,
    },
  }
}

/** A permit2 payload signed by a fresh EOA, then re-enveloped as if a smart
 * account produced it (the JSON shape is identical; only the signature
 * length differs). */
async function smartAccountPayment() {
  const requirements = permit2Requirements()
  const account = privateKeyToAccount(generatePrivateKey())
  const eoa = await buildPermit2ExactPayment({
    account,
    requirements,
    trustedSpenders: [spender],
  })
  return {
    requirements,
    from: eoa.payload.permit2Authorization.from,
    payment: { ...eoa, payload: { ...eoa.payload, signature: SMART_SIGNATURE } },
  }
}

class RecordingTransport implements B402Transport {
  verifyRequests: Parameters<B402Transport['verify']>[0][] = []
  settleRequests: Parameters<B402Transport['settle']>[0][] = []
  verifyPayer: `0x${string}`

  constructor(verifyPayer: `0x${string}`) {
    this.verifyPayer = verifyPayer
  }

  async supported(): Promise<SupportedResponse> {
    return { extensions: [], kinds: [], signers: {} }
  }

  async verify(request: Parameters<B402Transport['verify']>[0]) {
    this.verifyRequests.push(request)
    return { isValid: true, payer: this.verifyPayer }
  }

  async settle(request: Parameters<B402Transport['settle']>[0]) {
    this.settleRequests.push(request)
    return {
      amount: request.paymentRequirements.amount,
      network: request.paymentRequirements.network,
      payer: this.verifyPayer,
      success: true,
      transaction,
    }
  }
}

/** Map-backed atomic store — b402 carries no mppx dependency, so build one here. */
function memoryStore(): B402ReplayStore {
  const map = new Map<string, unknown>()
  return {
    get: async (key) => map.get(key) ?? null,
    update: async <result>(
      key: string,
      fn: (current: unknown) => B402ReplayChange<result>,
    ): Promise<result> => {
      const change = fn(map.get(key) ?? null)
      if (change.op === 'set') map.set(key, JSON.parse(JSON.stringify(change.value)))
      if (change.op === 'delete') map.delete(key)
      return change.result
    },
  }
}

/** Facilitator that rejects specific signature envelopes as invalid — the
 * on-chain ERC-1271 check is the only authority on smart-account signatures. */
class SelectiveTransport extends RecordingTransport {
  readonly invalidSignatures = new Set<string>()

  override async verify(request: Parameters<B402Transport['verify']>[0]) {
    this.verifyRequests.push(request)
    if (this.invalidSignatures.has(request.paymentPayload.payload.signature)) {
      return {
        invalidReason: 'invalid_exact_evm_payload_signature',
        isValid: false,
        payer: this.verifyPayer,
      }
    }
    return { isValid: true, payer: this.verifyPayer }
  }
}

describe('smart-account permit2 signatures (ERC-1271/ERC-7739)', () => {
  test('verify forwards the payment instead of failing the local recover', async () => {
    const { requirements, from, payment } = await smartAccountPayment()
    const transport = new RecordingTransport(from)
    const client = new B402FacilitatorClient({ client: transport })

    await expect(
      client.verify(asX402(payment), asX402Requirements(requirements)),
    ).resolves.toMatchObject({
      isValid: true,
      payer: from,
    })
    expect(transport.verifyRequests).toHaveLength(1)
    expect(transport.verifyRequests[0]?.paymentPayload.payload.signature).toBe(SMART_SIGNATURE)
  })

  test('verify cross-checks the facilitator-reported payer against the declared from', async () => {
    const { requirements, payment } = await smartAccountPayment()
    const transport = new RecordingTransport('0x9999999999999999999999999999999999999999')
    const client = new B402FacilitatorClient({ client: transport })

    await expect(
      client.verify(asX402(payment), asX402Requirements(requirements)),
    ).resolves.toMatchObject({
      invalidReason: 'payer_mismatch',
      isValid: false,
    })
  })

  test('settle forwards the payment with the declared from as the expectation payer', async () => {
    const { requirements, from, payment } = await smartAccountPayment()
    const transport = new RecordingTransport(from)
    const client = new B402FacilitatorClient({ client: transport })

    await expect(
      client.settle(asX402(payment), asX402Requirements(requirements)),
    ).resolves.toMatchObject({
      payer: from,
      success: true,
      transaction,
    })
    expect(transport.settleRequests).toHaveLength(1)
    expect(transport.settleRequests[0]?.paymentPayload.payload.signature).toBe(SMART_SIGNATURE)
  })
})

// ── Slot squatting on the smart-account path (audit H02 follow-up) ──────────
//
// The replay guard keys on the payer address, and on this path that address is
// the payload's SELF-DECLARED `from` (an ERC-1271 envelope has no recoverable
// key). Reserving before asking the facilitator therefore let an attacker who
// copied a victim's publicly-visible address + nonce claim the victim's slot
// with a garbage envelope, so the victim's genuine payment was rejected as
// "already in progress" without ever reaching the facilitator. The guard now
// confirms the signature via the idempotent, gas-free /verify first.
describe('smart-account replay-slot squatting', () => {
  test('a forged envelope is refused on the facilitator verdict and never claims the slot', async () => {
    const victim = await smartAccountPayment()
    const forgedSignature = `0x${'ee'.repeat(80)}` as const
    // Same declared `from` and same nonce as the victim — only the envelope
    // differs, and it is garbage.
    const forged = {
      ...victim.payment,
      payload: { ...victim.payment.payload, signature: forgedSignature },
    }

    const transport = new SelectiveTransport(victim.from)
    transport.invalidSignatures.add(forgedSignature)
    const client = new B402FacilitatorClient({ client: transport, store: memoryStore() })

    await expect(
      client.settle(asX402(forged), asX402Requirements(victim.requirements)),
    ).resolves.toMatchObject({
      errorReason: 'invalid_exact_evm_payload_signature',
      success: false,
      transaction: '',
    })
    expect(transport.settleRequests).toHaveLength(0) // never reached /settle

    // The victim's genuine payment still settles — its slot was never taken.
    await expect(
      client.settle(asX402(victim.payment), asX402Requirements(victim.requirements)),
    ).resolves.toMatchObject({ payer: victim.from, success: true, transaction })
    expect(transport.settleRequests).toHaveLength(1)
  })

  test('a facilitator-reported payer that contradicts the declared from is refused', async () => {
    const victim = await smartAccountPayment()
    // Facilitator vouches for the signature but names a different payer than
    // the address the slot would be keyed on.
    const transport = new SelectiveTransport('0x9999999999999999999999999999999999999999')
    const client = new B402FacilitatorClient({ client: transport, store: memoryStore() })

    await expect(
      client.settle(asX402(victim.payment), asX402Requirements(victim.requirements)),
    ).resolves.toMatchObject({ errorReason: 'payer_mismatch', success: false })
    expect(transport.settleRequests).toHaveLength(0)
  })

  test('the EOA path reserves with no extra verify round trip (local recover suffices)', async () => {
    const requirements = permit2Requirements()
    const account = privateKeyToAccount(generatePrivateKey())
    const eoa = await buildPermit2ExactPayment({
      account,
      requirements,
      trustedSpenders: [spender],
    })
    const transport = new SelectiveTransport(eoa.payload.permit2Authorization.from)
    const client = new B402FacilitatorClient({ client: transport, store: memoryStore() })

    await expect(
      client.settle(asX402(eoa), asX402Requirements(requirements)),
    ).resolves.toMatchObject({ success: true, transaction })
    expect(transport.verifyRequests).toHaveLength(0) // no added latency on the main path
    expect(transport.settleRequests).toHaveLength(1)
  })
})

describe('EOA regressions (unchanged local guards)', () => {
  test('a 65-byte permit2 signature still goes through recover-and-compare: a forged from is rejected locally', async () => {
    const requirements = permit2Requirements()
    const account = privateKeyToAccount(generatePrivateKey())
    const eoa = await buildPermit2ExactPayment({
      account,
      requirements,
      trustedSpenders: [spender],
    })
    const forged = {
      ...eoa,
      payload: {
        ...eoa.payload,
        permit2Authorization: {
          ...eoa.payload.permit2Authorization,
          from: payTo, // not the signer
        },
      },
    }
    const transport = new RecordingTransport(account.address)
    const client = new B402FacilitatorClient({ client: transport })

    await expect(
      client.verify(asX402(forged), asX402Requirements(requirements)),
    ).resolves.toMatchObject({
      invalidReason: 'invalid_payload',
      isValid: false,
    })
    expect(transport.verifyRequests).toHaveLength(0)
  })

  test('the eip3009 rail keeps rejecting non-recoverable signatures locally (facilitator is EOA-only there)', async () => {
    const requirements = eip3009Requirements()
    const account = privateKeyToAccount(generatePrivateKey())
    const eoa = await buildEip3009Payment({ account, requirements })
    const smart = { ...eoa, payload: { ...eoa.payload, signature: SMART_SIGNATURE } }
    const transport = new RecordingTransport(account.address)
    const client = new B402FacilitatorClient({ client: transport })

    await expect(
      client.verify(asX402(smart), asX402Requirements(requirements)),
    ).resolves.toMatchObject({
      invalidReason: 'invalid_payload',
      isValid: false,
    })
    expect(transport.verifyRequests).toHaveLength(0)
  })
})
