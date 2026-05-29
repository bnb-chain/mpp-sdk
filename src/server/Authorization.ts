/**
 * EIP-3009 authorization credential verifier (spec §8.2).
 *
 * Verifies + settles an EIP-3009 `TransferWithAuthorization` signature.
 * Curated token matrix must mark the (chain, token) pair as
 * `eip3009Supported: true` (invariant — verifyAuthorization throws
 * up-front if the matrix says no support, so production never reaches
 * the verifier for a token without EIP-3009).
 *
 * Algorithm (cheap-reject ordered; spec §8.2):
 *
 *   Local validation (no RPC, no slot reservation):
 *     1. payload.to === request.recipient
 *     2. payload.value === request.amount
 *     3. payload.nonce === eip3009Nonce(challenge.id, challenge.realm)
 *     4. payload.validBefore > now. Spec §8.2 also SHOULDs
 *        validBefore <= challenge.expires (a longer authorization window
 *        than the challenge encourages reuse). We do NOT
 *        currently implement that SHOULD check — neither warn nor reject.
 *        Tracked as future hardening; deployments that need it should
 *        wrap the verifier or land it as a follow-up patch.
 *     5. payload.validAfter <= now
 *     6. Curated EIP-712 domain (tokenName + tokenVersion) MUST be
 *        present — preflight reads `getCuratedEip712Domain` which throws
 *        if the matrix lacks support. Here we re-assert: caller MUST
 *        pass the resolved domain via ctx so we don't re-probe a stale
 *        curated state.
 *     7. viem.recoverTypedDataAddress with the EIP-3009 domain +
 *        TransferWithAuthorization types → recoveredSigner.
 *     8. recoveredSigner === payload.from (lowercase compare). If
 *        credential.source is present, recoveredSigner MUST equal the
 *        address from `did:pkh:eip155:<chainId>:<addr>`. (source is
 *        OPTIONAL for authorization; payload.from is the authoritative
 *        identity because the token contract uses it.)
 *
 *   On-chain (after local pass; replay slot reserved):
 *     9. Replay.reserve(authKey(chainId, currency, recoveredSigner,
 *        payload.nonce)). All 4 key components REQUIRED — see Replay.ts
 *        JSDoc on authKey.
 *    10. ERC20.balanceOf(from) >= value → release on fail.
 *    11. viem.parseSignature(payload.signature) → {v, r, s}.
 *    12. simulateContract(transferWithAuthorization(...)) → release on fail.
 *    13. writeContract → waitForTransactionReceipt. Broadcast fail →
 *        release; timeout → keep inflight (TTL); revert → release
 *        (nonce unconsumed on-chain).
 *    14. parseEventLogs(Transfer) matches (currency, from, to, value).
 *        Mismatch → markRejected (token consumed nonce on-chain).
 *    15. Replay.markConsumed.
 *    16. buildEvmReceipt with settlement txHash as `reference` + echo externalId.
 */

import { type Credential, Errors } from 'mppx'
import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  compactSignatureToSignature,
  parseCompactSignature,
  parseEventLogs,
  parseSignature,
  recoverTypedDataAddress,
  serializeSignature,
} from 'viem'

import { eip3009Domain, eip3009Nonce, eip3009Types } from '../protocol/TypedData.js'
import { type EvmReceipt, buildEvmReceipt } from './Receipt.js'
import {
  authKey,
  type ChargeStore,
  getReplaySlot,
  markConsumed,
  markRejected,
  release,
  reserve,
} from './Replay.js'

/* -------------------------------------------------------------------------- */
/*  ctx + args                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Authorization verifier context. Intentionally does NOT carry `currency` —
 * spec §8.2 + TypedData.ts both require the EIP-3009 domain
 * `verifyingContract` to equal `challenge.request.currency`. The verifier
 * reads currency from the wire request (`request.currency`) and uses that
 * single value as the EIP-712 domain target, the ERC20.balanceOf target,
 * the Replay.authKey deployment-namespace key, and the
 * `transferWithAuthorization` writeContract target. All four MUST agree;
 * reading wire ensures they do.
 *
 * The Charge.ts request hook (P1.1) guarantees the wire `currency` matches
 * the preflight-resolved value, so reading wire is safe in normal flows
 * while still being a defense-in-depth correctness fix.
 */
export interface AuthorizationVerifierCtx {
  readonly publicClient: PublicClient
  readonly store: ChargeStore
  readonly chainId: number
  readonly settlementSigner: WalletClient
  /**
   * Curated EIP-712 domain metadata for the resolved token. Must come
   * from `getCuratedEip712Domain(chain, token)` in preflightCharge — never
   * probed at verify time (spec §8.2 step 6 forbids BYO probing).
   */
  readonly eip712: { readonly name: string; readonly version: string }
}

interface AuthorizationPayload {
  readonly type: 'authorization'
  readonly from: Address
  readonly to: Address
  readonly value: string
  readonly validAfter: string
  readonly validBefore: string
  readonly nonce: Hex
  readonly signature: Hex
}

export interface AuthorizationVerifierArgs {
  readonly credential: Credential.Credential<AuthorizationPayload>
  readonly request: {
    readonly amount: string
    readonly currency: Address
    readonly recipient: Address
    readonly externalId?: string
  }
  readonly ctx: AuthorizationVerifierCtx
}

/* -------------------------------------------------------------------------- */
/*  ABIs                                                                      */
/* -------------------------------------------------------------------------- */

const ERC20_BALANCE_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
] as const

const EIP3009_TRANSFER_WITH_AUTHORIZATION_ABI = [
  {
    type: 'function',
    name: 'transferWithAuthorization',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

const TRANSFER_EVENT_ABI = [
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

/* -------------------------------------------------------------------------- */
/*  verifyAuthorization                                                       */
/* -------------------------------------------------------------------------- */

export async function verifyAuthorization({
  credential,
  request,
  ctx,
}: AuthorizationVerifierArgs): Promise<EvmReceipt> {
  const { publicClient, store, chainId, settlementSigner, eip712 } = ctx
  const payload = credential.payload
  // Wire truth — spec §8.2 + TypedData.ts: domain / authKey / balanceOf /
  // transferWithAuthorization target all bind to challenge.request.currency.
  const { amount, currency, recipient, externalId } = request
  const challengeId = credential.challenge.id

  // ── Step 1: payload.to === recipient ──────────────────────────────────
  if (payload.to.toLowerCase() !== recipient.toLowerCase()) {
    throw new Errors.VerificationFailedError({
      ...(challengeId && { id: challengeId }),
      reason: `authorization payload.to ${payload.to} != recipient ${recipient}`,
    })
  }

  // ── Step 2: payload.value === amount ──────────────────────────────────
  if (BigInt(payload.value) !== BigInt(amount)) {
    throw new Errors.VerificationFailedError({
      ...(challengeId && { id: challengeId }),
      reason: `authorization payload.value ${payload.value} != amount ${amount}`,
    })
  }

  // ── Step 3: nonce derived from challenge ──────────────────────────────
  const expectedNonce = eip3009Nonce(challengeId, credential.challenge.realm)
  if (payload.nonce.toLowerCase() !== expectedNonce.toLowerCase()) {
    throw new Errors.VerificationFailedError({
      ...(challengeId && { id: challengeId }),
      reason: `authorization nonce mismatch — expected ${expectedNonce}, got ${payload.nonce}`,
    })
  }

  // ── Step 4 + 5: validBefore + validAfter window ───────────────────────
  const nowSec = Math.floor(Date.now() / 1000)
  if (BigInt(payload.validBefore) <= BigInt(nowSec)) {
    throw new Errors.VerificationFailedError({
      ...(challengeId && { id: challengeId }),
      reason: `authorization validBefore ${payload.validBefore} <= now ${nowSec}`,
    })
  }
  if (BigInt(payload.validAfter) > BigInt(nowSec)) {
    throw new Errors.VerificationFailedError({
      ...(challengeId && { id: challengeId }),
      reason: `authorization validAfter ${payload.validAfter} > now ${nowSec}`,
    })
  }

  // ── Step 6: EIP-712 domain must already be resolved (caller responsibility) ─
  if (!eip712.name || !eip712.version) {
    throw new Errors.VerificationFailedError({
      ...(challengeId && { id: challengeId }),
      reason:
        'authorization requires curated EIP-712 domain (tokenName + tokenVersion); none provided',
    })
  }
  const domain = eip3009Domain({
    tokenName: eip712.name,
    tokenVersion: eip712.version,
    chainId,
    tokenAddress: currency,
  })

  // ── Normalize signature to standard 65-byte r||s||v ───────────────────
  //
  // The wire schema (src/Methods.ts evmSignature) accepts BOTH 65-byte
  // standard signatures AND 64-byte EIP-2098 compact signatures. viem's
  // recoverTypedDataAddress + the EIP-3009 contract ABI both want the
  // standard form — normalise once here so every downstream call sees
  // the same shape.
  const sigHexLen = payload.signature.length - 2 // strip 0x
  const normalizedSignature: Hex =
    sigHexLen === 128
      ? serializeSignature(compactSignatureToSignature(parseCompactSignature(payload.signature)))
      : payload.signature

  // ── Step 7: recover signer via EIP-712 ────────────────────────────────
  let recoveredSigner: Address
  try {
    recoveredSigner = await recoverTypedDataAddress({
      domain,
      types: eip3009Types,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: payload.from,
        to: payload.to,
        value: BigInt(payload.value),
        validAfter: BigInt(payload.validAfter),
        validBefore: BigInt(payload.validBefore),
        nonce: payload.nonce,
      },
      signature: normalizedSignature,
    })
  } catch (err) {
    throw new Errors.VerificationFailedError({
      ...(challengeId && { id: challengeId }),
      reason: `authorization EIP-712 recover failed: ${err instanceof Error ? err.message : String(err)}`,
    })
  }

  // ── Step 8: recoveredSigner === payload.from + optional source check ──
  if (recoveredSigner.toLowerCase() !== payload.from.toLowerCase()) {
    throw new Errors.VerificationFailedError({
      ...(challengeId && { id: challengeId }),
      reason: `recovered signer ${recoveredSigner} != payload.from ${payload.from}`,
    })
  }
  if (credential.source !== undefined) {
    const sourcePattern = new RegExp(`^did:pkh:eip155:${chainId}:(0x[0-9a-fA-F]{40})$`)
    const sourceMatch = sourcePattern.exec(credential.source)
    if (!sourceMatch) {
      throw new Errors.VerificationFailedError({
        ...(challengeId && { id: challengeId }),
        reason: `credential.source must match 'did:pkh:eip155:${chainId}:<address>'; got '${credential.source}'`,
      })
    }
    if (sourceMatch[1]!.toLowerCase() !== recoveredSigner.toLowerCase()) {
      throw new Errors.VerificationFailedError({
        ...(challengeId && { id: challengeId }),
        reason: `credential.source (${sourceMatch[1]}) does not match recovered EIP-3009 signer (${recoveredSigner})`,
      })
    }
  }

  // ── Step 9: atomic reserve ────────────────────────────────────────────
  const key = authKey(chainId, currency, recoveredSigner, payload.nonce)
  const claimed = await reserve(store, key)
  if (!claimed) {
    // Normalized read so a backend failure surfaces as
    // ReplayStoreUnavailableError instead of raw Redis/Postgres error.
    const current = await getReplaySlot(store, key)
    const reasonText =
      current?.state === 'consumed'
        ? `authorization credential already consumed (signer=${recoveredSigner}, nonce=${payload.nonce})`
        : current?.state === 'rejected'
          ? `authorization credential previously rejected: ${current.reason ?? 'unknown'}`
          : `concurrent verify in progress (signer=${recoveredSigner}, nonce=${payload.nonce})`
    throw new Errors.VerificationFailedError({
      ...(challengeId && { id: challengeId }),
      reason: reasonText,
    })
  }

  // `terminalPhase` flips to `true` only AFTER the EIP-3009
  // settlement tx mined successfully (receipt.status === 'success').
  // EIP-3009 reverts DO NOT consume the on-chain nonce — those release.
  // Once the call succeeds the token contract has burned the
  // authorization nonce; markRejected (log mismatch) and markConsumed
  // are both terminal. Safety-net release is locked out from that point.
  let terminalPhase = false
  try {
    // ── Step 10: balanceOf(from) >= value ───────────────────────────────
    const balance = (await publicClient.readContract({
      address: currency,
      abi: ERC20_BALANCE_ABI,
      functionName: 'balanceOf',
      args: [payload.from],
    })) as bigint
    if (balance < BigInt(payload.value)) {
      await release(store, key)
      throw new Errors.VerificationFailedError({
        ...(challengeId && { id: challengeId }),
        reason: `signer balance ${balance} < value ${payload.value}`,
      })
    }

    // ── Step 11: split signature into {v, r, s} ─────────────────────────
    //
    // `normalizedSignature` (computed above the try block) is always the
    // standard 65-byte r||s||v form — parseSignature returns a defined v.
    const parsed = parseSignature(normalizedSignature)
    const r = parsed.r
    const s = parsed.s
    const v = parsed.v
    if (v === undefined) {
      await release(store, key)
      throw new Errors.VerificationFailedError({
        ...(challengeId && { id: challengeId }),
        reason: 'authorization signature has no v after normalization (parseSignature anomaly)',
      })
    }

    // ── Step 12+13: simulate + write + wait ─────────────────────────────
    const args = [
      payload.from,
      payload.to,
      BigInt(payload.value),
      BigInt(payload.validAfter),
      BigInt(payload.validBefore),
      payload.nonce,
      Number(v),
      r,
      s,
    ] as const

    let txHash: Hex
    try {
      await publicClient.simulateContract({
        address: currency,
        abi: EIP3009_TRANSFER_WITH_AUTHORIZATION_ABI,
        functionName: 'transferWithAuthorization',
        args,
        account: settlementSigner.account!,
      })
      txHash = await settlementSigner.writeContract({
        address: currency,
        abi: EIP3009_TRANSFER_WITH_AUTHORIZATION_ABI,
        functionName: 'transferWithAuthorization',
        args,
        account: settlementSigner.account!,
        chain: settlementSigner.chain ?? null,
      })
    } catch (settleErr) {
      await release(store, key)
      throw new Errors.VerificationFailedError({
        ...(challengeId && { id: challengeId }),
        reason: `authorization simulate/broadcast failed: ${settleErr instanceof Error ? settleErr.message : String(settleErr)}`,
      })
    }

    let receipt: Awaited<ReturnType<PublicClient['waitForTransactionReceipt']>>
    try {
      receipt = await publicClient.waitForTransactionReceipt({ hash: txHash })
    } catch (waitErr) {
      throw new Errors.VerificationFailedError({
        ...(challengeId && { id: challengeId }),
        reason: `authorization waitForTransactionReceipt failed; slot remains inflight (TTL cleanup): ${
          waitErr instanceof Error ? waitErr.message : String(waitErr)
        }`,
      })
    }

    if (receipt.status !== 'success') {
      await release(store, key)
      throw new Errors.VerificationFailedError({
        ...(challengeId && { id: challengeId }),
        reason: `authorization settlement reverted on-chain (status=${receipt.status})`,
      })
    }

    // receipt.status === 'success' → EIP-3009 authorization
    // nonce IS now consumed on-chain (token contract burns it on
    // successful transferWithAuthorization). Enter terminal phase:
    // safety-net release is locked out to avoid re-admitting a
    // credential whose token-side nonce is already burned.
    terminalPhase = true

    // ── Step 14: Transfer log match (post-success → markRejected on miss) ─
    const transferLogs = parseEventLogs({
      abi: TRANSFER_EVENT_ABI,
      eventName: 'Transfer',
      logs: receipt.logs,
    })
    const expectedValue = BigInt(payload.value)
    const currencyLower = currency.toLowerCase()
    const fromLower = payload.from.toLowerCase()
    const toLower = payload.to.toLowerCase()
    const match = transferLogs.find(
      (log) =>
        log.address.toLowerCase() === currencyLower &&
        log.args.from.toLowerCase() === fromLower &&
        log.args.to.toLowerCase() === toLower &&
        log.args.value === expectedValue,
    )
    if (!match) {
      await markRejected(
        store,
        key,
        `Transfer log mismatch (currency=${currency} from=${payload.from} to=${payload.to} value=${payload.value}); nonce consumed`,
      )
      throw new Errors.VerificationFailedError({
        ...(challengeId && { id: challengeId }),
        reason: `no matching Transfer event for authorization (currency=${currency} from=${payload.from} to=${payload.to} value=${payload.value})`,
      })
    }

    // ── Step 15: mark consumed ──────────────────────────────────────────
    await markConsumed(store, key)

    // ── Step 16: build receipt ──────────────────────────────────────────
    return buildEvmReceipt({
      method: 'evm',
      status: 'success',
      challengeId,
      reference: txHash,
      timestamp: new Date().toISOString(),
      chainId,
      ...(externalId !== undefined && { externalId }),
    })
  } catch (err) {
    // Secondary store.get/release in this safety net MUST
    // NOT mask the original `err`. If the backend itself is the cause
    // (ReplayStoreUnavailableError from reserve / markConsumed earlier),
    // these cleanup calls will throw — swallow+log so the user sees
    // the original failure.
    //
    // If `terminalPhase` is set, the EIP-3009 authorization
    // nonce IS consumed on-chain and a terminal store-write was in
    // flight. Releasing here would re-admit a credential whose
    // authorization nonce is burned — next reserve+verify would
    // re-execute transferWithAuthorization, the token contract would
    // revert "FiatTokenV2: authorization is used or canceled", and
    // the user would see a misleading error. Keep slot inflight; TTL /
    // operator handles cleanup.
    if (err instanceof Errors.VerificationFailedError) throw err
    if (terminalPhase) {
      // eslint-disable-next-line no-console -- terminal-phase operator hint
      console.warn(
        '[verifyAuthorization] terminal-phase store write failed; slot remains inflight ' +
          '(TTL cleanup) to avoid double-spend. Original error:',
        err instanceof Error ? err.message : String(err),
      )
      throw err
    }
    try {
      const current = await getReplaySlot(store, key)
      if (current?.state === 'inflight') {
        await release(store, key)
      }
    } catch (cleanupErr) {
      // eslint-disable-next-line no-console -- intentional one-off operator hint
      console.warn(
        '[verifyAuthorization] safety-net cleanup failed; original error takes precedence:',
        cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      )
    }
    throw err
  }
}
