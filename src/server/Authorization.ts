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
 *     4. payload.validBefore > now, AND (spec §5.3.2 SHOULD) validBefore
 *        must not exceed challenge.expires by more than a fixed tolerance
 *        — a longer authorization window than the challenge leaves a
 *        signed, anyone-can-submit transfer redeemable off-protocol.
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
 *    10. ERC20.balanceOf(from) >= value. On a shortfall, run the front-run
 *        recovery probe first (an already-settled front-run drains the
 *        balance) — release only when the nonce is genuinely unconsumed.
 *    11. viem.parseSignature(normalizedSignature) → {v, r, s}.
 *    12. simulateContract(transferWithAuthorization(...)). Failure →
 *        front-run recovery probe (authorizationState + AuthorizationUsed/
 *        AuthorizationCanceled logs). Three outcomes: 'recovered' (a third
 *        party landed the exact authorized transfer at >= ctx.confirmations
 *        depth → consume + receipt referencing THEIR tx), 'pending'
 *        (settlement evidence inconclusive or probe errored → keep slot
 *        inflight, throw retryable), 'none' (unconsumed or genuinely canceled
 *        → release).
 *    13. writeContract → waitForTransactionReceipt (confirmations +
 *        optional timeout). Broadcast fail → recovery probe (as in 12);
 *        timeout → keep inflight (reserve() reclaims after inflightTtlMs);
 *        revert → recovery probe (as in 12).
 *    14. parseEventLogs(Transfer) matches (currency, from, to, value).
 *        Mismatch → markRejected (token consumed nonce on-chain).
 *    15. consumeSlotBestEffort (markConsumed with retry; never fails a
 *        verify whose settlement is already on-chain-final).
 *    16. buildEvmReceipt with settlement txHash as `reference` + echo externalId.
 */

import { type Credential, Errors } from 'mppx'
import {
  type Address,
  type Hex,
  type Log,
  type PublicClient,
  type WalletClient,
  parseEventLogs,
  recoverTypedDataAddress,
} from 'viem'

import { eip3009Domain, eip3009Nonce, eip3009Types } from '../protocol/TypedData.js'
import {
  TRANSFER_EVENT_ABI,
  assertDidPkhSourceMatches,
  consumeSlotBestEffort,
  handleVerifierFailure,
  normalizeEvmSignature,
  throwReserveConflict,
} from './charge/verifierKit.js'
import { type EvmReceipt, buildEvmReceipt } from './Receipt.js'
import { authKey, type ChargeStore, markRejected, release, reserve } from './Replay.js'
import {
  LocalSignerAdapter,
  SettlePendingError,
  SettleRejectedError,
  type SettleAdapter,
  type SettleReceipt,
} from './Settle.js'

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
  /**
   * Local settlement signer for the default `LocalSignerAdapter`. OPTIONAL when
   * an external `settleBackend` is supplied.
   */
  readonly settlementSigner?: WalletClient
  /**
   * Override the on-chain settle step. Default:
   * `LocalSignerAdapter(settlementSigner)`. Set an external Adapter to delegate
   * EIP-3009 settlement to another broadcaster.
   */
  readonly settleBackend?: SettleAdapter
  /**
   * Curated EIP-712 domain metadata for the resolved token. Must come
   * from `getCuratedEip712Domain(chain, token)` in preflightCharge — never
   * probed at verify time (spec §8.2 step 6 forbids BYO probing).
   */
  readonly eip712: { readonly name: string; readonly version: string }
  /**
   * Confirmation depth for the settlement receipt wait (deployment policy,
   * spec §7.5). Same knob the transaction/hash verifiers honor.
   */
  readonly confirmations: number
  /**
   * Max milliseconds to wait for the settlement receipt. Unset → viem
   * default (180s). See Permit2VerifierCtx.settlementTimeoutMs.
   */
  readonly settlementTimeoutMs?: number
  /** Stale-inflight reclaim age forwarded to Replay.reserve. */
  readonly inflightTtlMs?: number
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

/**
 * Slack allowed between `payload.validBefore` and `challenge.expires`
 * before the §5.3.2 SHOULD check rejects. Generous enough for clients
 * that sign a fixed now+10min window against a ~5min challenge expiry;
 * tight enough to stop multi-hour off-protocol redemption windows.
 */
const VALID_BEFORE_TOLERANCE_SEC = 600n

const ERC20_BALANCE_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
] as const

/** EIP-3009 standard getter — true once the (authorizer, nonce) pair is used OR canceled. */
const EIP3009_AUTHORIZATION_STATE_ABI = [
  {
    type: 'function',
    name: 'authorizationState',
    inputs: [
      { name: 'authorizer', type: 'address' },
      { name: 'nonce', type: 'bytes32' },
    ],
    outputs: [{ type: 'bool' }],
    stateMutability: 'view',
  },
] as const

/**
 * EIP-3009 standard event, emitted on successful use (NOT on cancel —
 * cancel emits AuthorizationCanceled). Both params indexed → getLogs can
 * pinpoint the exact tx that consumed the authorization.
 */
const AUTHORIZATION_USED_EVENT_ABI = {
  type: 'event',
  name: 'AuthorizationUsed',
  inputs: [
    { name: 'authorizer', type: 'address', indexed: true },
    { name: 'nonce', type: 'bytes32', indexed: true },
  ],
} as const

/**
 * EIP-3009 standard event, emitted by cancelAuthorization (the
 * no-payment way to burn a nonce). The recovery probe queries it in the
 * same window as AuthorizationUsed to distinguish a genuine cancel
 * (release + surface the original error) from a settlement that predates
 * the search window (keep slot inflight — payment may have happened).
 */
const AUTHORIZATION_CANCELED_EVENT_ABI = {
  type: 'event',
  name: 'AuthorizationCanceled',
  inputs: [
    { name: 'authorizer', type: 'address', indexed: true },
    { name: 'nonce', type: 'bytes32', indexed: true },
  ],
} as const

/**
 * How far back (in blocks) the front-run recovery searches for the
 * AuthorizationUsed / AuthorizationCanceled events. Must outlast the
 * inflight-reclaim window (DEFAULT_INFLIGHT_TTL_MS = 10min): a reclaimed
 * retry re-probes a burned nonce, and if the consuming tx has scrolled
 * past the window the probe can no longer prove payment. 5000 blocks ≈
 * ~21min on the fastest curated chain (arbitrum ~0.25s blocks) vs the
 * 10-min reclaim — the old 1000-block window covered only ~4min there —
 * while staying within common public-RPC getLogs range caps.
 */
const FRONT_RUN_SEARCH_WINDOW_BLOCKS = 5000n

/**
 * Parse the numeric chain id out of a CAIP-2 `eip155:<ref>` network string, or
 * `null` if it isn't an `eip155` network we can read. Tolerant of casing, surrounding
 * whitespace, and a `0x`-hex or decimal reference — so the `facilitator`-proof check
 * compares on the parsed id (not the raw echo) and isn't false-rejected over
 * `EIP155:56` vs `eip155:56`. An unreadable echo returns `null`, which the caller
 * treats as a mismatch (fail closed — the b402 path has no other integrity check).
 */
function caip2ChainId(network: string): number | null {
  const ref = /^eip155:(0x[0-9a-f]+|\d+)$/i.exec(network.trim())?.[1]?.toLowerCase()
  if (ref === undefined) return null
  const n = ref.startsWith('0x') ? Number.parseInt(ref, 16) : Number.parseInt(ref, 10)
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * Front-run recovery probe decision (see recoverFrontRunSettlement):
 *   - 'recovered': the exact authorized transfer settled at sufficient
 *     confirmation depth — slot consumed, receipt references the
 *     consuming tx.
 *   - 'pending':   evidence is inconclusive (settlement too shallow,
 *     nonce burned but neither event found in the search window, or the
 *     probe itself errored) — the caller MUST keep the slot inflight and
 *     throw a retryable error.
 *   - 'none':      nonce unconsumed, or genuinely canceled — the caller
 *     releases the slot and surfaces the original failure.
 */
type FrontRunProbeOutcome =
  | { readonly kind: 'recovered'; readonly receipt: EvmReceipt }
  /** EVIDENCE-based hold: the nonce IS burned on-chain but the consuming tx is
   *  unlocatable / below confirmation depth — a payment may have landed. */
  | { readonly kind: 'pending'; readonly reason: string }
  /** The probe itself could not EXECUTE (authorizationState reverted — e.g. a
   *  facilitator-gated token like testnet $U — or a transport failure). No
   *  evidence either way; each call site decides fail-open vs fail-closed. */
  | { readonly kind: 'unreadable'; readonly reason: string }
  | { readonly kind: 'none' }

/** Viem contract errors span many lines; HTTP `reason` strings keep the first. */
function firstLine(message: string): string {
  return message.split('\n', 1)[0] ?? message
}

/* -------------------------------------------------------------------------- */
/*  verifyAuthorization                                                       */
/* -------------------------------------------------------------------------- */

export async function verifyAuthorization({
  credential,
  request,
  ctx,
}: AuthorizationVerifierArgs): Promise<EvmReceipt> {
  const {
    publicClient,
    store,
    chainId,
    settlementSigner,
    settleBackend,
    eip712,
    confirmations,
    settlementTimeoutMs,
    inflightTtlMs,
  } = ctx
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
  // Both fields passed the canonical positive-integer schema (`^[1-9]\d*$`,
  // no leading zeros, ≤78 digits), so string equality IS numeric equality —
  // no BigInt conversion on wire input (audit M04 defense-in-depth; the
  // schema length cap is the primary guard).
  if (payload.value !== amount) {
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

  // Spec §5.3.2 SHOULD: "validBefore SHOULD correspond to the challenge
  // expires timestamp." A validBefore far beyond expires leaves a signed,
  // anyone-can-submit transfer redeemable on-chain long after the challenge
  // window closed. Reject when it exceeds expires by more than the
  // tolerance (which accommodates clients that default to a fixed window
  // like now+10min against a typical ~5min challenge expiry).
  const expiresIso = credential.challenge.expires
  if (expiresIso !== undefined) {
    const expiresMs = Date.parse(expiresIso)
    if (Number.isFinite(expiresMs)) {
      const maxValidBefore = BigInt(Math.floor(expiresMs / 1000)) + VALID_BEFORE_TOLERANCE_SEC
      if (BigInt(payload.validBefore) > maxValidBefore) {
        throw new Errors.VerificationFailedError({
          ...(challengeId && { id: challengeId }),
          reason:
            `authorization validBefore ${payload.validBefore} exceeds challenge expires ` +
            `(${expiresIso}) by more than ${VALID_BEFORE_TOLERANCE_SEC}s — spec §5.3.2: ` +
            'validBefore SHOULD correspond to the challenge expires timestamp',
        })
      }
    }
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

  // ── Normalize signature to canonical 65-byte r||s||v (legacy v) ───────
  //
  // The wire schema (src/Methods.ts evmSignature) accepts 65-byte standard
  // signatures (legacy 27/28 OR yParity 0/1 final byte) AND 64-byte
  // EIP-2098 compact signatures. viem recovery, parseSignature, and the
  // EIP-3009 contract's on-chain ecrecover all want the canonical form —
  // normalize once here so every downstream call sees the same shape.
  const normalizedSignature = normalizeEvmSignature(payload.signature)

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
  assertDidPkhSourceMatches({
    chainId,
    source: credential.source,
    required: false,
    expectedAddress: recoveredSigner,
    challengeId,
    expectedLabel: 'recovered EIP-3009 signer',
  })

  // ── Step 9: atomic reserve ────────────────────────────────────────────
  const key = authKey(chainId, currency, recoveredSigner, payload.nonce)
  const claimed = await reserve(store, key, { inflightTtlMs })
  if (!claimed) {
    return await throwReserveConflict({
      store,
      key,
      challengeId,
      describe: {
        consumed: `authorization credential already consumed (signer=${recoveredSigner}, nonce=${payload.nonce})`,
        rejected: (reason) =>
          `authorization credential previously rejected: ${reason ?? 'unknown'}`,
        inflight: `concurrent verify in progress (signer=${recoveredSigner}, nonce=${payload.nonce})`,
      },
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
    // ── Front-run recovery ──────────────────────────────────────────────
    // transferWithAuthorization is anyone-can-submit: a mempool observer
    // — or the payer themselves — can land the identical calldata before
    // our settlement tx. OUR call then simulate-fails or reverts
    // ("authorization is used or canceled") even though the payment
    // SETTLED. Before failing a payer who may have paid, check whether
    // the authorization was consumed by a tx performing the exact
    // authorized transfer. See FrontRunProbeOutcome for the decision
    // matrix the caller must honor.
    const recoverFrontRunSettlement = async (): Promise<FrontRunProbeOutcome> => {
      try {
        const used = (await publicClient.readContract({
          address: currency,
          abi: EIP3009_AUTHORIZATION_STATE_ABI,
          functionName: 'authorizationState',
          args: [payload.from, payload.nonce],
        })) as boolean
        // Unconsumed → genuine failure, no recovery.
        if (!used) return { kind: 'none' }

        // Used OR canceled — a use emits AuthorizationUsed, a cancel
        // emits AuthorizationCanceled. Search one shared window for both.
        const latestBlock = await publicClient.getBlockNumber()
        const fromBlock =
          latestBlock > FRONT_RUN_SEARCH_WINDOW_BLOCKS
            ? latestBlock - FRONT_RUN_SEARCH_WINDOW_BLOCKS
            : 0n
        const usedLogs = await publicClient.getLogs({
          address: currency,
          event: AUTHORIZATION_USED_EVENT_ABI,
          args: { authorizer: payload.from, nonce: payload.nonce },
          fromBlock,
          toBlock: latestBlock,
        })
        const usedLog = usedLogs[0]
        if (!usedLog?.transactionHash) {
          const canceledLogs = await publicClient.getLogs({
            address: currency,
            event: AUTHORIZATION_CANCELED_EVENT_ABI,
            args: { authorizer: payload.from, nonce: payload.nonce },
            fromBlock,
            toBlock: latestBlock,
          })
          // Genuine cancel — no payment happened; original error stands.
          if (canceledLogs.length > 0) return { kind: 'none' }
          // The nonce is burned on-chain but NEITHER event is in the
          // window: the consuming tx most likely settled before fromBlock
          // (e.g. a reclaimed-inflight retry minutes later on a fast
          // chain). Releasing would re-open the slot for a payment that
          // may have settled — keep it inflight, let the operator decide.
          return {
            kind: 'pending',
            reason:
              'authorization nonce consumed on-chain but the consuming tx was not located ' +
              `within the last ${FRONT_RUN_SEARCH_WINDOW_BLOCKS} blocks — it may have settled ` +
              'before the search window; operator may locate it and mark the slot manually',
          }
        }

        const frontRunReceipt = await publicClient.getTransactionReceipt({
          hash: usedLog.transactionHash,
        })
        if (frontRunReceipt.status !== 'success') return { kind: 'none' }
        // Same Transfer match as step 14: the consuming tx must contain
        // the exact authorized (currency, from, to, value) transfer.
        const frontRunTransfers = parseEventLogs({
          abi: TRANSFER_EVENT_ABI,
          eventName: 'Transfer',
          logs: frontRunReceipt.logs,
        })
        const paid = frontRunTransfers.some(
          (log) =>
            log.address.toLowerCase() === currency.toLowerCase() &&
            log.args.from.toLowerCase() === payload.from.toLowerCase() &&
            log.args.to.toLowerCase() === payload.to.toLowerCase() &&
            log.args.value === BigInt(payload.value),
        )
        if (!paid) return { kind: 'none' }

        // The transfer settled — but only accept it at the deployment's
        // confirmation depth (ctx.confirmations, same policy as the
        // settlement wait and the hash verifier). Consuming on a shallow
        // receipt risks a reorg dropping the transfer AFTER the slot is
        // irreversibly consumed.
        const tip = await publicClient.getBlockNumber()
        const depth =
          tip >= frontRunReceipt.blockNumber ? tip - frontRunReceipt.blockNumber + 1n : 0n
        if (depth < BigInt(confirmations)) {
          return {
            kind: 'pending',
            reason:
              'front-run settlement found at insufficient confirmation depth ' +
              `(have ${depth}, need ${confirmations}); retry shortly`,
          }
        }

        // The authorized transfer DID settle — terminal from here.
        terminalPhase = true
        await consumeSlotBestEffort(store, key, '[verifyAuthorization]')
        return {
          kind: 'recovered',
          receipt: buildEvmReceipt({
            method: 'evm',
            status: 'success',
            challengeId,
            reference: usedLog.transactionHash,
            timestamp: new Date().toISOString(),
            chainId,
            ...(externalId !== undefined && { externalId }),
          }),
        }
      } catch (recoveryErr) {
        // The probe itself failed to EXECUTE — authorizationState reverted
        // (facilitator-gated tokens like testnet $U gate that view) or a
        // transport error. This is NOT evidence the nonce is burned; report
        // 'unreadable' and let each call site pick fail-open vs fail-closed
        // (pre-settle shortfall releases; post-settle keeps the slot).
        const msg = recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr)
        // eslint-disable-next-line no-console -- operator hint
        console.warn('[verifyAuthorization] front-run recovery probe errored:', msg)
        return {
          kind: 'unreadable',
          reason: `front-run probe unavailable (authorizationState read failed: ${firstLine(msg)})`,
        }
      }
    }

    // ── Step 10: balanceOf(from) >= value ───────────────────────────────
    // A shortfall can mean the EXACT authorized transfer was already
    // front-run-settled (recipient paid V, the nonce burned, the balance
    // drained below V), so probe recovery BEFORE failing a payer who may have
    // paid — an unconditional release here would strand a completed payment
    // with no receipt (and every retry re-fails the same balance check).
    const balance = (await publicClient.readContract({
      address: currency,
      abi: ERC20_BALANCE_ABI,
      functionName: 'balanceOf',
      args: [payload.from],
    })) as bigint
    if (balance < BigInt(payload.value)) {
      const probe = await recoverFrontRunSettlement()
      if (probe.kind === 'recovered') return probe.receipt
      if (probe.kind === 'pending') {
        // Evidence-based hold: the nonce IS burned but the consuming tx is
        // unlocatable / shallow — carry the balance context so the buyer can
        // tell this apart from a routine shortfall.
        throw new Errors.VerificationFailedError({
          ...(challengeId && { id: challengeId }),
          reason: `${probe.reason} (context: signer balance ${balance} < value ${payload.value})`,
        })
      }
      // 'none' (nonce genuinely unconsumed) OR 'unreadable' (probe cannot run —
      // e.g. facilitator-gated tokens where authorizationState reverts for
      // everyone but the facilitator): no settle was attempted in THIS flow, so
      // releasing only re-admits verification — it cannot double-settle. Fail
      // with the REAL, actionable shortfall error instead of a probe artifact.
      await release(store, key, claimed)
      throw new Errors.VerificationFailedError({
        ...(challengeId && { id: challengeId }),
        reason:
          `signer balance ${balance} < value ${payload.value}` +
          (probe.kind === 'unreadable' ? ` (${probe.reason})` : ''),
      })
    }

    // ── Step 11-13: delegate the broadcast to the settle adapter ────────
    // Default: LocalSignerAdapter(settlementSigner) — the original
    // simulate→write→wait. An external Adapter can delegate broadcasting.
    // Only route to `settleBackend` when it DECLARES `authorization` in
    // `settles` (see Settle.ts SettleAdapter JSDoc — that's the machine-checkable
    // contract). A backend configured for some other purpose must not silently
    // receive an authorization it never claimed to handle; fall back to the
    // local signer instead (preflight already required one in that case).
    const authBackend = settleBackend?.settles.includes('authorization') ? settleBackend : undefined
    const settle =
      authBackend ?? (settlementSigner ? new LocalSignerAdapter(settlementSigner) : undefined)
    if (!settle) {
      await release(store, key, claimed)
      throw new Errors.VerificationFailedError({
        ...(challengeId && { id: challengeId }),
        reason: 'no settlement backend configured (settleBackend or settlementSigner required)',
      })
    }

    let settleReceipt: SettleReceipt
    try {
      settleReceipt = await settle.settleAuthorization(
        {
          token: currency,
          chainId,
          from: payload.from,
          to: payload.to,
          value: BigInt(payload.value),
          validAfter: BigInt(payload.validAfter),
          validBefore: BigInt(payload.validBefore),
          nonce: payload.nonce,
          signature: normalizedSignature,
          eip712,
        },
        {
          publicClient,
          confirmations,
          ...(settlementTimeoutMs !== undefined && { settlementTimeoutMs }),
        },
      )
    } catch (settleErr) {
      const settleMsg = firstLine(
        settleErr instanceof Error ? settleErr.message : String(settleErr),
      )
      // SettlePendingError = tx broadcast but receipt unconfirmed (timeout):
      // keep the slot INFLIGHT (reclaimed after inflightTtlMs) — the tx may
      // still mine and burn the nonce.
      if (settleErr instanceof SettlePendingError) {
        throw new Errors.VerificationFailedError({
          ...(challengeId && { id: challengeId }),
          reason: settleErr.message,
        })
      }
      // Pre-mine failure — the authorization may have been front-run by a tx
      // performing the exact authorized transfer. See FrontRunProbeOutcome.
      const probe = await recoverFrontRunSettlement()
      if (probe.kind === 'recovered') return probe.receipt
      if (probe.kind === 'pending') {
        // Never mask the underlying settle failure with the probe outcome.
        throw new Errors.VerificationFailedError({
          ...(challengeId && { id: challengeId }),
          reason: `${probe.reason}; underlying settle failure: ${settleMsg}`,
        })
      }
      // SettleRejectedError = the backend DEFINITIVELY rejected pre-broadcast
      // (e.g. b402 refused the payout/params) — nothing was broadcast by us, so
      // even when the probe is unreadable, releasing is safe (a retry can only
      // re-enter verification) and the backend's reason is the actionable one.
      if (settleErr instanceof SettleRejectedError) {
        await release(store, key, claimed)
        throw new Errors.VerificationFailedError({
          ...(challengeId && { id: challengeId }),
          reason: `settle backend rejected the authorization pre-broadcast: ${settleMsg}`,
        })
      }
      if (probe.kind === 'unreadable') {
        // Unknown broadcast state + unreadable nonce state → fail CLOSED (keep
        // the slot inflight; reclaimed after inflightTtlMs), but surface BOTH
        // failures so the outcome is diagnosable.
        throw new Errors.VerificationFailedError({
          ...(challengeId && { id: challengeId }),
          reason: `${probe.reason}; underlying settle failure: ${settleMsg}`,
        })
      }
      await release(store, key, claimed)
      throw new Errors.VerificationFailedError({
        ...(challengeId && { id: challengeId }),
        reason: `authorization simulate/broadcast failed: ${settleMsg}`,
      })
    }

    if (settleReceipt.status !== 'success') {
      // Our tx reverted — but a front-runner's tx may have paid the recipient.
      const probe = await recoverFrontRunSettlement()
      if (probe.kind === 'recovered') return probe.receipt
      if (probe.kind === 'pending') {
        throw new Errors.VerificationFailedError({
          ...(challengeId && { id: challengeId }),
          reason: `${probe.reason}; our settle tx ${settleReceipt.transactionHash} reverted`,
        })
      }
      // 'none' or 'unreadable': an EIP-3009 revert does NOT consume the nonce,
      // so OUR side burned nothing — releasing is safe either way. When the
      // probe was unreadable, say so (third-party front-run state unknown).
      await release(store, key, claimed)
      throw new Errors.VerificationFailedError({
        ...(challengeId && { id: challengeId }),
        reason:
          `authorization settlement reverted on-chain ` +
          `(tx=${settleReceipt.transactionHash}, status=${settleReceipt.status})` +
          (probe.kind === 'unreadable' ? ` (${probe.reason})` : ''),
      })
    }

    // Settlement succeeded → the EIP-3009 nonce IS consumed on-chain. Enter
    // terminal phase: safety-net release is locked out to avoid re-admitting a
    // credential whose token-side nonce is already burned.
    terminalPhase = true

    // ── Step 14: confirm the settled transfer matched the authorization ──
    // The verifier — never the adapter — judges this. `logs` proof (the local
    // signer broadcast it itself): match the authorized ERC-20 Transfer. A
    // `facilitator` proof (b402 broadcast it and echoed back what it settled):
    // assert the echoed payer/network/amount equal the authorized
    // from/chainId/value. Either mismatch means the on-chain nonce was burned on
    // a transfer we did NOT authorize → markRejected + fail.
    const proof = settleReceipt.proof
    if (proof.kind === 'logs') {
      const transferLogs = parseEventLogs({
        abi: TRANSFER_EVENT_ABI,
        eventName: 'Transfer',
        logs: proof.logs as Log[],
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
    } else {
      // The facilitator path reads NO on-chain logs — this echo IS the only
      // post-settle integrity check, so it must POSITIVELY confirm the authorized
      // transfer (fail CLOSED, never assume). An incomplete or unreadable proof is
      // a mismatch, not a pass.
      const mismatches: string[] = []
      if (proof.payer.toLowerCase() !== payload.from.toLowerCase()) {
        mismatches.push(`payer=${proof.payer} != from=${payload.from}`)
      }
      // Compare on the PARSED chain id so only cosmetic CAIP-2 format diffs
      // (`EIP155:1` / `eip155:0x1`) are tolerated; an unreadable network is a
      // mismatch (b402 emits canonical `eip155:<n>`, so this never fires for an
      // honest settlement, and we refuse to credit a network we can't read).
      const settledChainId = caip2ChainId(proof.network)
      if (settledChainId !== chainId) {
        mismatches.push(`network=${proof.network} != eip155:${chainId}`)
      }
      // amount MUST be present (b402 echoes it on success) and equal the value.
      if (proof.amount === undefined || proof.amount !== BigInt(payload.value)) {
        mismatches.push(`amount=${proof.amount ?? '(missing)'} != value=${payload.value}`)
      }
      if (mismatches.length > 0) {
        await markRejected(
          store,
          key,
          `facilitator settled a different transfer than authorized (${mismatches.join('; ')}); nonce consumed`,
        )
        throw new Errors.VerificationFailedError({
          ...(challengeId && { id: challengeId }),
          reason: `facilitator settlement does not match authorization (${mismatches.join('; ')})`,
        })
      }
    }

    // ── Step 15: mark consumed ──────────────────────────────────────────
    // A store failure here must NOT surface as an error to a paid payer (see
    // consumeSlotBestEffort: retries transient blips, then warns and returns;
    // the slot staying inflight still blocks replay).
    await consumeSlotBestEffort(store, key, '[verifyAuthorization]')

    // ── Step 16: build receipt ──────────────────────────────────────────
    return buildEvmReceipt({
      method: 'evm',
      status: 'success',
      challengeId,
      reference: settleReceipt.transactionHash,
      timestamp: new Date().toISOString(),
      chainId,
      ...(externalId !== undefined && { externalId }),
    })
  } catch (err) {
    // Safety net for unexpected errors that bypass our explicit
    // release/markRejected handling (see handleVerifierFailure).
    //
    // If `terminalPhase` is set, the EIP-3009 authorization
    // nonce IS consumed on-chain and a terminal store-write was in
    // flight. Releasing here would re-admit a credential whose
    // authorization nonce is burned — next reserve+verify would
    // re-execute transferWithAuthorization, the token contract would
    // revert "FiatTokenV2: authorization is used or canceled", and
    // the user would see a misleading error. Keep slot inflight —
    // reserve() reclaims it after inflightTtlMs, and the front-run
    // recovery probe then resolves the burned-nonce state.
    return await handleVerifierFailure({
      err,
      store,
      key,
      token: claimed,
      terminalPhase,
      label: '[verifyAuthorization]',
      cleanupNoun: 'cleanup',
    })
  }
}
