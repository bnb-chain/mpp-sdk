/**
 * Hash credential — real mppx integration (spec §14.5.1.2).
 *
 * Goal: exercise the full `Mppx.create(...) → verifyCredential(...)` pipeline
 * with a real `charge(...)` server, the live `verifyHash`, and a stubbed
 * `publicClient` (so the test stays offline + deterministic).
 *
 * Asserts:
 *   - The handler accepts the credential (HMAC + Expires + verifyHash + the
 *     stub Transfer log all line up)
 *   - The returned Receipt contains every draft §7.6 Table 13 REQUIRED field,
 *     including method-specific `challengeId` and `chainId`
 *
 * `verifyCredential` returns the Receipt directly (not a Response); the
 * `Payment-Receipt` header round-trip is exercised separately in
 * Transport.test.ts via the dedicated `evmHttpTransport().respondReceipt`
 * fail-closed tests. Together those two test surfaces cover the full path
 * spec §14.5.1.2 mandates: verifier success → buildEvmReceipt → wire bytes
 * preserved on header decode.
 *
 * The second describe block covers the draft §7.6/§9 HTTP error contract:
 * failing credentials driven through the full mppx HTTP route
 * (`handler.evm.charge(...)(Request)`) must produce a 402 Response with a
 * fresh `WWW-Authenticate: Payment` challenge, an `application/problem+json`
 * body using the §9 standard problem types, and — critically — NO
 * `Payment-Receipt` header (§7.6: "Servers MUST NOT include a
 * Payment-Receipt header on error responses").
 */

import { Credential } from 'mppx'
import { Mppx } from 'mppx/server'
import { type PublicClient, encodeAbiParameters, encodeEventTopics } from 'viem'
import { describe, expect, test } from 'vitest'

import { preflightChargeForTest } from '../../test/helpers/server/preflightChargeForTest.js'
import { charge } from './Charge.js'

const SECRET = 'integration-test-secret-at-least-32-bytes' as const
const RECIPIENT = '0x2222222222222222222222222222222222222222' as const
const PAYER = '0x4444444444444444444444444444444444444444' as const
const TX = `0x${'cd'.repeat(32)}` as const
const USDC_ETHEREUM = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const
// PERMIT2 fixture no longer needed at the route layer —
// server defaults inject methodDetails.permit2Address.
const AMOUNT = '1000000'

const TRANSFER_ABI = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const

function happyStubPublicClient(): PublicClient {
  return {
    async getTransactionReceipt() {
      return {
        blockHash: `0x${'a'.repeat(64)}`,
        blockNumber: 100n,
        contractAddress: null,
        cumulativeGasUsed: 0n,
        effectiveGasPrice: 0n,
        from: PAYER,
        gasUsed: 0n,
        logs: [
          {
            address: USDC_ETHEREUM,
            blockHash: `0x${'b'.repeat(64)}`,
            blockNumber: 100n,
            data: encodeAbiParameters([{ type: 'uint256' }], [BigInt(AMOUNT)]),
            logIndex: 0,
            removed: false,
            topics: encodeEventTopics({
              abi: TRANSFER_ABI,
              eventName: 'Transfer',
              args: { from: PAYER, to: RECIPIENT },
            }),
            transactionHash: TX,
            transactionIndex: 0,
          },
        ],
        logsBloom: '0x',
        status: 'success' as const,
        to: USDC_ETHEREUM,
        transactionHash: TX,
        transactionIndex: 0,
        type: 'eip1559' as const,
      }
    },
    async getBlockNumber() {
      // ethereum default confirmations is 12 → need ≥ 111 to satisfy.
      return 200n
    },
  } as unknown as PublicClient
}

describe('§14.5.1.2 — hash credential real mppx pipeline', () => {
  test('verifyCredential through real mppx returns receipt with draft §7.6 fields', async () => {
    const prepared = await preflightChargeForTest(
      {
        chain: 'ethereum',
        token: 'USDC',
        recipient: RECIPIENT,
        credentialTypes: ['hash'],
        challengeBinding: { mode: 'mppx-managed' }, // mppx HMAC + Expires
      },
      {
        mockedIsContractDeployed: () => true,
        publicClient: happyStubPublicClient(),
      },
    )
    const server = charge(prepared)
    const handler = Mppx.create({
      methods: [server],
      secretKey: SECRET,
    })

    // Factory return type preserves `ChargeServerDefaults`
    // as the 2nd generic, so handler.challenge.evm.charge accepts just the
    // per-call fields and defaults inject the rest. Partial methodDetails
    // at the route level is also forbidden — minimal-route is the
    // only correct shape now.
    const fullRequestArgs = {
      amount: AMOUNT,
      externalId: 'order-int-1',
    }

    // Issue a real challenge through mppx so the HMAC id is HMAC(SECRET).
    const challenge = await handler.challenge.evm.charge(fullRequestArgs)

    // Build the hash credential bound to that challenge.
    const credential = Credential.from({
      challenge,
      payload: { type: 'hash', hash: TX },
    })
    const serialized = Credential.serialize(credential)

    // Run the full mppx pipeline: deserialize → HMAC check → Expires.assert
    // → method schema validation → verifyHash. Returns the Receipt directly
    // (Receipt → header bytes is exercised in Transport.test.ts).
    const receipt = await handler.verifyCredential(serialized, {
      request: fullRequestArgs,
    })

    expect(receipt).toMatchObject({
      method: 'evm',
      status: 'success',
      reference: TX,
      challengeId: challenge.id,
      chainId: 1,
      externalId: 'order-int-1',
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/),
    })
  })
})

/* -------------------------------------------------------------------------- */
/*  §7.6 + §9 — HTTP error contract through the real mppx route               */
/* -------------------------------------------------------------------------- */

const TX_REVERTED = `0x${'ee'.repeat(32)}` as const

/**
 * Stub publicClient whose receipt lookup returns a REVERTED transaction.
 * Confirmations still pass (blockNumber 100, latest 200 → 101 ≥ 12), so
 * `verifyHash` reaches step 4 (`receipt.status !== 'success'`) and throws
 * `Errors.VerificationFailedError` — the §9 `verification-failed` case.
 */
function revertedStubPublicClient(): PublicClient {
  return {
    async getTransactionReceipt() {
      return {
        blockHash: `0x${'a'.repeat(64)}`,
        blockNumber: 100n,
        contractAddress: null,
        cumulativeGasUsed: 0n,
        effectiveGasPrice: 0n,
        from: PAYER,
        gasUsed: 0n,
        logs: [],
        logsBloom: '0x',
        status: 'reverted' as const,
        to: USDC_ETHEREUM,
        transactionHash: TX_REVERTED,
        transactionIndex: 0,
        type: 'eip1559' as const,
      }
    },
    async getBlockNumber() {
      return 200n
    },
  } as unknown as PublicClient
}

/** Builds the full real-mppx HTTP route used by every error-contract test. */
async function setupHttpRoute(publicClient: PublicClient) {
  const prepared = await preflightChargeForTest(
    {
      chain: 'ethereum',
      token: 'USDC',
      recipient: RECIPIENT,
      credentialTypes: ['hash'],
      challengeBinding: { mode: 'mppx-managed' },
    },
    {
      mockedIsContractDeployed: () => true,
      publicClient,
    },
  )
  const server = charge(prepared)
  // Explicit realm: route-mode challenges derive realm from the Request URL
  // hostname when Mppx.create has none, while `handler.challenge.*` (no
  // captured request) falls back to mppx's default realm — the Tier-2 pinned
  // `realm` binding would then reject the credential with invalid-challenge
  // before the verifier ever runs. Pinning the realm here (as any real
  // deployment does) keeps both sides identical.
  const handler = Mppx.create({
    methods: [server],
    realm: 'api.test.example',
    secretKey: SECRET,
  })
  const fullRequestArgs = {
    amount: AMOUNT,
    externalId: 'order-int-err',
  }
  // The configured route: `(input: Request) => Promise<MethodFn.Response>`.
  // On failure mppx returns `{ status: 402, challenge: Response }` where
  // `challenge` is the actual HTTP Response built by the transport's
  // `respondChallenge` (evmHttpTransport inherits it from Transport.http()).
  const route = handler.evm.charge(fullRequestArgs)
  return { handler, route, fullRequestArgs }
}

/** Narrows the mppx route result to the 402 branch and returns the Response. */
function expect402Response(
  result: Awaited<ReturnType<Awaited<ReturnType<typeof setupHttpRoute>>['route']>>,
): Response {
  expect(result.status).toBe(402)
  if (result.status !== 402) throw new Error('expected 402 route result')
  return result.challenge
}

describe('§7.6 + §9 — HTTP error contract through real mppx route', () => {
  test('reverted tx → 402, fresh WWW-Authenticate, problem+json verification-failed, NO Payment-Receipt', async () => {
    const { handler, route, fullRequestArgs } = await setupHttpRoute(revertedStubPublicClient())

    // Issue a real challenge through mppx (HMAC id = HMAC(SECRET)) and bind
    // a hash credential whose receipt lookup will come back reverted.
    const challenge = await handler.challenge.evm.charge(fullRequestArgs)
    const credential = Credential.from({
      challenge,
      payload: { type: 'hash', hash: TX_REVERTED },
    })

    // Full pipeline: Authorization parse → HMAC → stable binding → Expires
    // → payload schema → verifyHash (throws VerificationFailedError on the
    // reverted receipt) → transport.respondChallenge.
    const result = await route(
      new Request('https://api.test.example/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )
    const response = expect402Response(result)

    // (1) §9: HTTP 402 Payment Required.
    expect(response.status).toBe(402)

    // (2) §9: a fresh `WWW-Authenticate: Payment` challenge is present.
    const wwwAuthenticate = response.headers.get('WWW-Authenticate')
    expect(wwwAuthenticate).not.toBeNull()
    expect(wwwAuthenticate!.startsWith('Payment ')).toBe(true)
    expect(wwwAuthenticate).toMatch(/id="[^"]+"/)

    // (3) §7.6: "Servers MUST NOT include a Payment-Receipt header on error
    // responses".
    expect(response.headers.get('Payment-Receipt')).toBeNull()

    // (4) §9: Problem Details body with one of the three standard types —
    // a failing on-chain verification maps to `verification-failed`.
    expect(response.headers.get('Content-Type')).toBe('application/problem+json')
    const problem = await response.json()
    expect(problem.status).toBe(402)
    expect(problem.type).toContain('verification-failed')
    expect(problem.detail).toMatch(/reverted/i)
  })

  test('malformed Authorization credential → 402, NO Payment-Receipt, problem+json malformed-credential', async () => {
    // happyStubPublicClient is never reached — the credential fails to
    // deserialize before any verifier runs.
    const { route } = await setupHttpRoute(happyStubPublicClient())

    const result = await route(
      new Request('https://api.test.example/resource', {
        headers: { Authorization: 'Payment not-valid-base64url-credential!!!' },
      }),
    )
    const response = expect402Response(result)

    expect(response.status).toBe(402)
    const wwwAuthenticate = response.headers.get('WWW-Authenticate')
    expect(wwwAuthenticate).not.toBeNull()
    expect(wwwAuthenticate!.startsWith('Payment ')).toBe(true)
    expect(response.headers.get('Payment-Receipt')).toBeNull()

    // mppx maps a garbage Authorization value (Credential.deserialize throws
    // InvalidCredentialEncodingError) to Errors.MalformedCredentialError,
    // whose problem type URI is
    // `https://paymentauth.org/problems/malformed-credential` — which IS one
    // of the three §9 standard types (malformed-credential /
    // invalid-challenge / verification-failed).
    expect(response.headers.get('Content-Type')).toBe('application/problem+json')
    const problem = await response.json()
    expect(problem.status).toBe(402)
    expect(problem.type).toContain('malformed-credential')
  })
})
