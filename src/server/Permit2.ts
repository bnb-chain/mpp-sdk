/**
 * Permit2 credential verifier (spec §8.1).
 *
 * Verifies + settles a Permit2 PaymentWitness signature. Supports both
 * single-permit (no splits) and batch-permit (splits per draft §4.2.3)
 * paths via the same algorithm; the discriminator is `splits.length`.
 *
 * Algorithm (cheap-reject ordered; spec §8.1):
 *
 *   Local validation (no RPC, no slot reservation):
 *     1. (handled by Charge.ts routing) payload.type === 'permit2'
 *     2. permit.deadline > now (unix seconds)
 *     3. length match — no splits: 1+1, with splits: 1+N === 1+N
 *     4. each permitted[i].token === currency
 *     5. each i: BigInt(permitted[i].amount) >= BigInt(transferDetails[i].requestedAmount)
 *     6. transferDetails[0].to === recipient
 *     7. transferDetails[0].requestedAmount === amount - sum(splits[].amount)
 *     8. each split i: transferDetails[i+1].to === splits[i].recipient AND
 *                      transferDetails[i+1].requestedAmount === splits[i].amount
 *     9. witness.challengeHash === computeChallengeHash(challenge.id, challenge.realm)
 *    10. viem.verifyTypedData(...) → recoveredSigner (primaryType per single/batch)
 *    11. credential.source is REQUIRED and MUST equal
 *        `did:pkh:eip155:${chainId}:${recoveredSigner}` (draft §6.1 normative)
 *
 *   On-chain (after local pass; replay slot reserved):
 *    12. Replay.reserve(permit2Key(chainId, permit2Address, recoveredSigner, nonce))
 *    13. ERC20.balanceOf(recoveredSigner) >= totalAmount → release on fail
 *    14. ERC20.allowance(recoveredSigner, permit2Address) >= totalAmount → release on fail
 *    15. simulateContract(permitWitnessTransferFrom / permitBatchWitnessTransferFrom)
 *        → on fail, probe nonceBitmap first: nonce already consumed →
 *        keep inflight (an earlier settlement attempt may have landed);
 *        otherwise release
 *    16. writeContract → waitForTransactionReceipt. Broadcast failure →
 *        release; timeout → keep inflight (reclaimed after
 *        inflightTtlMs); revert → release (nonce
 *        unconsumed on-chain).
 *    17. parseEventLogs(Transfer) strictly matches ALL expected transfers
 *        (currency, recoveredSigner-as-from, each (to, value) pair in order).
 *        Mismatch → markRejected (nonce IS consumed on-chain; permanent).
 *    18. consumeSlotBestEffort (a store blip never fails a paid payer).
 *    19. buildEvmReceipt with settlement txHash as `reference` + echo externalId.
 *
 * The receipt.status === success + log mismatch case is the most subtle
 * replay decision: Permit2 has consumed the nonce, so the credential is
 * unreplayable; markRejected reflects "known-bad" (not retryable) without
 * pretending it was a successful charge.
 */

import { type Credential, Errors } from 'mppx'
import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  encodeAbiParameters,
  keccak256,
  parseEventLogs,
  recoverTypedDataAddress,
  toBytes,
} from 'viem'

import {
  PERMIT2_WITNESS_TYPE_STRING,
  computeChallengeHash,
  permit2BatchTypes,
  permit2Domain,
  permit2SingleTypes,
} from '../protocol/TypedData.js'
import {
  TRANSFER_EVENT_ABI,
  assertDidPkhSourceMatches,
  consumeSlotBestEffort,
  handleVerifierFailure,
  normalizeEvmSignature,
  throwReserveConflict,
} from './charge/verifierKit.js'
import { type EvmReceipt, buildEvmReceipt } from './Receipt.js'
import { type ChargeStore, markRejected, permit2Key, release, reserve } from './Replay.js'

/* -------------------------------------------------------------------------- */
/*  ctx + args                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Permit2 verifier context. Intentionally does NOT carry permit2Address —
 * spec §8.1 mandates the verifier read it from the wire request
 * (`request.methodDetails.permit2Address`, draft Table 2 REQUIRED). That
 * wire truth is what the EIP-712 domain, ERC20.allowance(spender),
 * Replay.permit2Key, and the settlement-tx write target all bind to.
 *
 * The Charge.ts `request` hook (spec §14.10 P1.1 fix) guarantees the
 * wire permit2Address matches the preflight-resolved value, so reading
 * from the wire is safe in normal flows but still defends against any
 * future misconfiguration.
 */
export interface Permit2VerifierCtx {
  readonly publicClient: PublicClient
  readonly store: ChargeStore
  readonly chainId: number
  readonly settlementSigner: WalletClient
  /**
   * Confirmation depth for the settlement receipt wait (deployment policy,
   * spec §7.5). Same knob the transaction/hash verifiers honor.
   */
  readonly confirmations: number
  /**
   * Max milliseconds to wait for the settlement receipt. Unset → viem
   * default (180s). Deployments behind load balancers with shorter idle
   * timeouts should set this below the LB timeout so the client receives
   * the retryable error instead of a severed connection.
   */
  readonly settlementTimeoutMs?: number
  /** Stale-inflight reclaim age forwarded to Replay.reserve. */
  readonly inflightTtlMs?: number
}

interface PermitPayload {
  readonly type: 'permit2'
  readonly permit: {
    readonly permitted: ReadonlyArray<{ readonly token: Address; readonly amount: string }>
    readonly nonce: string
    readonly deadline: string
  }
  readonly transferDetails: ReadonlyArray<{
    readonly to: Address
    readonly requestedAmount: string
  }>
  readonly witness: { readonly challengeHash: Hex }
  readonly signature: Hex
}

interface SplitsRequest {
  readonly recipient: Address
  readonly amount: string
  readonly memo?: string
}

export interface Permit2VerifierArgs {
  readonly credential: Credential.Credential<PermitPayload>
  readonly request: {
    readonly amount: string
    readonly currency: Address
    readonly recipient: Address
    readonly externalId?: string
    readonly methodDetails: {
      /**
       * Permit2 contract address — wire truth (draft Table 2 REQUIRED).
       * Used as the EIP-712 domain verifyingContract, the
       * ERC20.allowance spender, the Replay.permit2Key
       * deployment-namespace key, and the writeContract target. All four
       * MUST agree; reading wire ensures they do.
       */
      readonly permit2Address: Address
      /**
       * Settlement-signer address — `msg.sender` at on-chain Permit2 call
       * time. Wire field per `methodDetails.permit2Spender`. MUST equal
       * `ctx.settlementSigner.account.address`; the verify path below
       * cross-checks (split brain here yields InvalidSigner at settlement).
       */
      readonly permit2Spender?: Address
      readonly splits?: ReadonlyArray<SplitsRequest>
    }
  }
  readonly ctx: Permit2VerifierCtx
}

/* -------------------------------------------------------------------------- */
/*  ABIs                                                                      */
/* -------------------------------------------------------------------------- */

/** ERC-20 read-only ABI fragments (`balanceOf`, `allowance`). */
const ERC20_READ_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'allowance',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
] as const

/** Permit2 single-permit `permitWitnessTransferFrom`. */
const PERMIT2_SINGLE_ABI = [
  {
    type: 'function',
    name: 'permitWitnessTransferFrom',
    inputs: [
      {
        name: 'permit',
        type: 'tuple',
        components: [
          {
            name: 'permitted',
            type: 'tuple',
            components: [
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
          },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      {
        name: 'transferDetails',
        type: 'tuple',
        components: [
          { name: 'to', type: 'address' },
          { name: 'requestedAmount', type: 'uint256' },
        ],
      },
      { name: 'owner', type: 'address' },
      { name: 'witness', type: 'bytes32' },
      { name: 'witnessTypeString', type: 'string' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

/** Permit2 batch-permit `permitWitnessTransferFrom` (overloaded selector). */
const PERMIT2_BATCH_ABI = [
  {
    type: 'function',
    name: 'permitWitnessTransferFrom',
    inputs: [
      {
        name: 'permit',
        type: 'tuple',
        components: [
          {
            name: 'permitted',
            type: 'tuple[]',
            components: [
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
          },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      {
        name: 'transferDetails',
        type: 'tuple[]',
        components: [
          { name: 'to', type: 'address' },
          { name: 'requestedAmount', type: 'uint256' },
        ],
      },
      { name: 'owner', type: 'address' },
      { name: 'witness', type: 'bytes32' },
      { name: 'witnessTypeString', type: 'string' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

/**
 * Permit2 `nonceBitmap` read — probes whether an unordered nonce is
 * already consumed on-chain (wordPos = nonce >> 8, bit = nonce & 255).
 * Used by the simulate/broadcast failure path to distinguish "credential
 * is retryable" from "our own earlier settlement attempt already landed".
 */
const PERMIT2_NONCE_BITMAP_ABI = [
  {
    type: 'function',
    name: 'nonceBitmap',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'wordPos', type: 'uint256' },
    ],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
] as const

/**
 * EIP-712 typeHash for `PaymentWitness(bytes32 challengeHash)`. Used to
 * compute the `bytes32 witness` parameter to Permit2 — Permit2 contract
 * expects the hashStruct of the witness data, not the raw struct.
 */
const PAYMENT_WITNESS_TYPEHASH = keccak256(toBytes('PaymentWitness(bytes32 challengeHash)'))

/* -------------------------------------------------------------------------- */
/*  verifyPermit2                                                             */
/* -------------------------------------------------------------------------- */

export async function verifyPermit2({
  credential,
  request,
  ctx,
}: Permit2VerifierArgs): Promise<EvmReceipt> {
  const {
    publicClient,
    store,
    chainId,
    settlementSigner,
    confirmations,
    settlementTimeoutMs,
    inflightTtlMs,
  } = ctx
  const { permit, transferDetails, witness, signature } = credential.payload
  const { amount, currency, recipient, externalId } = request
  // Wire truth — spec §8.1 + draft Table 2. Domain / allowance / replay
  // key / write target all bind to this single value.
  const permit2Address = request.methodDetails.permit2Address
  const splits = request.methodDetails.splits ?? []
  // Settlement signer address from the wire challenge — used as the
  // EIP-712 `spender` for both recovery (here) and the on-chain Permit2
  // call below. Cross-checked against ctx.settlementSigner.account.address
  // so a tampered challenge can't redirect the user's signed spender to
  // an attacker-controlled address while keeping the same id.
  const wirePermit2Spender = request.methodDetails.permit2Spender
  const ctxPermit2Spender = ctx.settlementSigner.account?.address
  if (!wirePermit2Spender) {
    throw new Errors.VerificationFailedError({
      reason:
        'permit2 verifier requires request.methodDetails.permit2Spender in the challenge — ' +
        'the wire field is REQUIRED for permit2 because Permit2 uses msg.sender as the EIP-712 ' +
        'spender, so the user must sign with the settlement-signer address. Issued challenges ' +
        'from server SDKs pre-dating the spender-bug fix omit this field and cannot settle.',
    })
  }
  if (!ctxPermit2Spender || wirePermit2Spender.toLowerCase() !== ctxPermit2Spender.toLowerCase()) {
    throw new Errors.VerificationFailedError({
      reason:
        `request.methodDetails.permit2Spender (${wirePermit2Spender}) does not match ` +
        `ctx.settlementSigner.account.address (${ctxPermit2Spender ?? '<none>'}) — ` +
        'attacker may be redirecting the spender, or the deployment swapped settlement keys ' +
        'without re-issuing the challenge.',
    })
  }
  const permit2Spender: Address = wirePermit2Spender
  const challengeId = credential.challenge.id

  // ── Step 2: deadline ──────────────────────────────────────────────────
  const nowSec = Math.floor(Date.now() / 1000)
  if (BigInt(permit.deadline) <= BigInt(nowSec)) {
    throw new Errors.VerificationFailedError({
      ...(challengeId && { id: challengeId }),
      reason: `permit2 deadline ${permit.deadline} <= now ${nowSec}`,
    })
  }

  // ── Step 3: length match ──────────────────────────────────────────────
  const isBatch = splits.length > 0
  const expectedLen = isBatch ? 1 + splits.length : 1
  if (permit.permitted.length !== expectedLen) {
    throw new Errors.VerificationFailedError({
      ...(challengeId && { id: challengeId }),
      reason: `permit.permitted.length ${permit.permitted.length} != expected ${expectedLen}`,
    })
  }
  if (transferDetails.length !== expectedLen) {
    throw new Errors.VerificationFailedError({
      ...(challengeId && { id: challengeId }),
      reason: `transferDetails.length ${transferDetails.length} != expected ${expectedLen}`,
    })
  }

  // ── Step 4: each permitted token === currency ─────────────────────────
  const currencyLower = currency.toLowerCase()
  for (const [i, perm] of permit.permitted.entries()) {
    if (perm.token.toLowerCase() !== currencyLower) {
      throw new Errors.VerificationFailedError({
        ...(challengeId && { id: challengeId }),
        reason: `permit.permitted[${i}].token ${perm.token} != currency ${currency}`,
      })
    }
  }

  // ── Step 5: each i: permitted.amount >= transferDetails.requestedAmount ─
  for (let i = 0; i < expectedLen; i++) {
    const permittedAmt = BigInt(permit.permitted[i]!.amount)
    const requestedAmt = BigInt(transferDetails[i]!.requestedAmount)
    if (permittedAmt < requestedAmt) {
      throw new Errors.VerificationFailedError({
        ...(challengeId && { id: challengeId }),
        reason: `permit.permitted[${i}].amount ${permittedAmt} < transferDetails[${i}].requestedAmount ${requestedAmt}`,
      })
    }
  }

  // ── Step 6: transferDetails[0].to === recipient ───────────────────────
  const recipientLower = recipient.toLowerCase()
  if (transferDetails[0]!.to.toLowerCase() !== recipientLower) {
    throw new Errors.VerificationFailedError({
      ...(challengeId && { id: challengeId }),
      reason: `transferDetails[0].to ${transferDetails[0]!.to} != recipient ${recipient}`,
    })
  }

  // ── Step 7: transferDetails[0].requestedAmount === amount - sum(splits) ─
  const totalAmount = BigInt(amount)
  const splitsSum = splits.reduce((sum, s) => sum + BigInt(s.amount), 0n)
  const expectedPrimary = totalAmount - splitsSum
  if (BigInt(transferDetails[0]!.requestedAmount) !== expectedPrimary) {
    throw new Errors.VerificationFailedError({
      ...(challengeId && { id: challengeId }),
      reason: `transferDetails[0].requestedAmount ${transferDetails[0]!.requestedAmount} != amount - sum(splits) = ${expectedPrimary}`,
    })
  }

  // ── Step 8: each split match ──────────────────────────────────────────
  for (let i = 0; i < splits.length; i++) {
    const td = transferDetails[i + 1]!
    const split = splits[i]!
    if (td.to.toLowerCase() !== split.recipient.toLowerCase()) {
      throw new Errors.VerificationFailedError({
        ...(challengeId && { id: challengeId }),
        reason: `transferDetails[${i + 1}].to ${td.to} != splits[${i}].recipient ${split.recipient}`,
      })
    }
    if (BigInt(td.requestedAmount) !== BigInt(split.amount)) {
      throw new Errors.VerificationFailedError({
        ...(challengeId && { id: challengeId }),
        reason: `transferDetails[${i + 1}].requestedAmount ${td.requestedAmount} != splits[${i}].amount ${split.amount}`,
      })
    }
  }

  // ── Step 9: witness.challengeHash ─────────────────────────────────────
  const expectedChallengeHash = computeChallengeHash(challengeId, credential.challenge.realm)
  if (witness.challengeHash.toLowerCase() !== expectedChallengeHash.toLowerCase()) {
    throw new Errors.VerificationFailedError({
      ...(challengeId && { id: challengeId }),
      reason: `witness.challengeHash mismatch — expected ${expectedChallengeHash}, got ${witness.challengeHash}`,
    })
  }

  // ── Step 10: EIP-712 verify + recover signer ──────────────────────────
  const domain = permit2Domain(chainId, permit2Address)

  // Normalize to canonical 65-byte r||s||v (legacy 27/28 v) form — the
  // wire schema accepts EIP-2098 compact and yParity-final-byte variants,
  // but viem recovery, parseSignature, and the Permit2 contract's
  // on-chain ecrecover all want the canonical shape. The single
  // `normalizedSignature` value flows to both the recover path here and
  // the simulate/writeContract paths at step 16.
  const normalizedSignature = normalizeEvmSignature(signature)

  // Build the typed-data message reading from credential.payload. nonce +
  // deadline are uint256 represented as decimal strings → BigInt.
  let recoveredSigner: Address
  try {
    if (isBatch) {
      const message = {
        permitted: permit.permitted.map((p) => ({
          token: p.token,
          amount: BigInt(p.amount),
        })),
        spender: permit2Spender,
        nonce: BigInt(permit.nonce),
        deadline: BigInt(permit.deadline),
        witness: { challengeHash: witness.challengeHash },
      }
      recoveredSigner = await recoverTypedDataAddress({
        domain,
        types: permit2BatchTypes,
        primaryType: 'PermitBatchWitnessTransferFrom',
        message,
        signature: normalizedSignature,
      })
    } else {
      const message = {
        permitted: {
          token: permit.permitted[0]!.token,
          amount: BigInt(permit.permitted[0]!.amount),
        },
        spender: permit2Spender,
        nonce: BigInt(permit.nonce),
        deadline: BigInt(permit.deadline),
        witness: { challengeHash: witness.challengeHash },
      }
      recoveredSigner = await recoverTypedDataAddress({
        domain,
        types: permit2SingleTypes,
        primaryType: 'PermitWitnessTransferFrom',
        message,
        signature: normalizedSignature,
      })
    }
  } catch (err) {
    throw new Errors.VerificationFailedError({
      ...(challengeId && { id: challengeId }),
      reason: `permit2 EIP-712 recover failed: ${err instanceof Error ? err.message : String(err)}`,
    })
  }

  // viem.recoverTypedDataAddress is math-only (sig → address); it returns
  // SOME address even from a garbage signature. The credential.source
  // check below catches that — a garbage sig yields a bogus recovered
  // address that won't match what the credential claims. So we don't
  // need a separate verifyTypedData double-call.

  // ── Step 11: credential.source matches recoveredSigner ────────────────
  assertDidPkhSourceMatches({
    chainId,
    source: credential.source,
    required: true,
    expectedAddress: recoveredSigner,
    challengeId,
    requiredReason: `permit2 requires credential.source (draft §6.1): expected 'did:pkh:eip155:${chainId}:${recoveredSigner}'`,
    expectedLabel: 'recovered Permit2 signer',
  })

  // ── Step 12: atomic reserve ───────────────────────────────────────────
  const key = permit2Key(chainId, permit2Address, recoveredSigner, permit.nonce)
  const claimed = await reserve(store, key, { inflightTtlMs })
  if (!claimed) {
    return await throwReserveConflict({
      store,
      key,
      challengeId,
      describe: {
        consumed: `permit2 credential already consumed (signer=${recoveredSigner}, nonce=${permit.nonce})`,
        rejected: (reason) => `permit2 credential previously rejected: ${reason ?? 'unknown'}`,
        inflight: `concurrent verify in progress for permit2 credential (signer=${recoveredSigner}, nonce=${permit.nonce})`,
      },
    })
  }

  // `terminalPhase` flips to `true` only AFTER we've confirmed the
  // Permit2 settlement tx mined successfully (receipt.status === 'success').
  // Permit2 reverts DO NOT consume the on-chain nonce — those release the
  // slot. Once the call succeeded on-chain the Permit2 nonce is burned;
  // markRejected (log mismatch) and markConsumed (full success) are both
  // terminal. Safety-net release locked out from that point.
  let terminalPhase = false
  try {
    // ── Steps 13-14: balanceOf + allowance (independent reads, parallel) ─
    const [balance, allowance] = (await Promise.all([
      publicClient.readContract({
        address: currency,
        abi: ERC20_READ_ABI,
        functionName: 'balanceOf',
        args: [recoveredSigner],
      }),
      publicClient.readContract({
        address: currency,
        abi: ERC20_READ_ABI,
        functionName: 'allowance',
        args: [recoveredSigner, permit2Address],
      }),
    ])) as [bigint, bigint]
    if (balance < totalAmount) {
      await release(store, key, claimed)
      throw new Errors.VerificationFailedError({
        ...(challengeId && { id: challengeId }),
        reason: `signer balance ${balance} < totalAmount ${totalAmount}`,
      })
    }
    if (allowance < totalAmount) {
      await release(store, key, claimed)
      throw new Errors.VerificationFailedError({
        ...(challengeId && { id: challengeId }),
        reason: `ERC20.allowance(signer, permit2) ${allowance} < totalAmount ${totalAmount}`,
      })
    }

    // ── Step 15-16: simulate + write + wait ─────────────────────────────
    // Compute witness bytes32 (Permit2 wants the hashStruct, not the raw).
    const witnessHash = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }],
        [PAYMENT_WITNESS_TYPEHASH, witness.challengeHash],
      ),
    )

    const baseArgs = {
      address: permit2Address,
      account: settlementSigner.account!,
    }

    // simulate first, then write with the EXACT request the simulation
    // validated (viem's simulate→request idiom) — guarantees the broadcast
    // call can't drift from what was simulated.
    let txHash: Hex
    try {
      if (isBatch) {
        const permitTuple = {
          permitted: permit.permitted.map((p) => ({
            token: p.token,
            amount: BigInt(p.amount),
          })),
          nonce: BigInt(permit.nonce),
          deadline: BigInt(permit.deadline),
        }
        const detailsTuples = transferDetails.map((d) => ({
          to: d.to,
          requestedAmount: BigInt(d.requestedAmount),
        }))
        const { request: simRequest } = await publicClient.simulateContract({
          ...baseArgs,
          abi: PERMIT2_BATCH_ABI,
          functionName: 'permitWitnessTransferFrom',
          args: [
            permitTuple,
            detailsTuples,
            recoveredSigner,
            witnessHash,
            PERMIT2_WITNESS_TYPE_STRING,
            normalizedSignature, // normalized to 65-byte form for contract
          ],
        })
        txHash = await settlementSigner.writeContract({
          ...simRequest,
          chain: settlementSigner.chain ?? null,
        })
      } else {
        const permitTuple = {
          permitted: {
            token: permit.permitted[0]!.token,
            amount: BigInt(permit.permitted[0]!.amount),
          },
          nonce: BigInt(permit.nonce),
          deadline: BigInt(permit.deadline),
        }
        const detailsTuple = {
          to: transferDetails[0]!.to,
          requestedAmount: BigInt(transferDetails[0]!.requestedAmount),
        }
        const { request: simRequest } = await publicClient.simulateContract({
          ...baseArgs,
          abi: PERMIT2_SINGLE_ABI,
          functionName: 'permitWitnessTransferFrom',
          args: [
            permitTuple,
            detailsTuple,
            recoveredSigner,
            witnessHash,
            PERMIT2_WITNESS_TYPE_STRING,
            normalizedSignature, // normalized to 65-byte form for contract
          ],
        })
        txHash = await settlementSigner.writeContract({
          ...simRequest,
          chain: settlementSigner.chain ?? null,
        })
      }
    } catch (settleErr) {
      // simulate or broadcast failed — USUALLY before any on-chain state
      // change. But not always: if our own earlier settlement attempt
      // landed after a receipt-wait timeout + stale-inflight reclaim, the
      // Permit2 nonce is ALREADY consumed and the simulate revert
      // (InvalidNonce) would otherwise hand a PAID payer a terminal-
      // looking failure while releasing the slot. Probe the Permit2
      // nonceBitmap (wordPos = nonce >> 8, bit = nonce & 255) to decide.
      const nonceBig = BigInt(permit.nonce)
      let nonceConsumed = false
      try {
        const bitmap = (await publicClient.readContract({
          address: permit2Address,
          abi: PERMIT2_NONCE_BITMAP_ABI,
          functionName: 'nonceBitmap',
          args: [recoveredSigner, nonceBig >> 8n],
        })) as bigint
        nonceConsumed = ((bitmap >> (nonceBig & 255n)) & 1n) === 1n
      } catch {
        // Bitmap probe failed — fall through to the release path below;
        // the original settleErr is the actionable signal.
      }
      if (nonceConsumed) {
        // Nonce burned on-chain → keep the slot INFLIGHT (no release).
        // reserve() reclaims it after inflightTtlMs; meanwhile the
        // operator can locate the settlement tx and resolve the slot.
        throw new Errors.VerificationFailedError({
          ...(challengeId && { id: challengeId }),
          reason:
            'permit2 nonce is already consumed on-chain — an earlier settlement attempt may ' +
            'have landed; operator: locate the settlement tx from the settlement signer ' +
            'history and mark the slot manually',
        })
      }
      // Nonce unconsumed (or probe failed): no on-chain state change to
      // protect; release so the client can retry.
      await release(store, key, claimed)
      throw new Errors.VerificationFailedError({
        ...(challengeId && { id: challengeId }),
        reason: `permit2 simulate/broadcast failed: ${settleErr instanceof Error ? settleErr.message : String(settleErr)}`,
      })
    }

    // Wait for receipt at the deployment's confirmation depth (spec §7.5
    // policy — same knob the transaction/hash verifiers honor).
    let receipt: Awaited<ReturnType<PublicClient['waitForTransactionReceipt']>>
    try {
      receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations,
        ...(settlementTimeoutMs !== undefined && { timeout: settlementTimeoutMs }),
      })
    } catch (waitErr) {
      // Timeout — keep the slot inflight: the tx may still mine and burn
      // the nonce. reserve() reclaims stale inflight slots after
      // inflightTtlMs, at which point a retry re-runs the on-chain probes.
      throw new Errors.VerificationFailedError({
        ...(challengeId && { id: challengeId }),
        reason: `permit2 waitForTransactionReceipt failed; slot remains inflight until reclaim: ${
          waitErr instanceof Error ? waitErr.message : String(waitErr)
        }`,
      })
    }

    if (receipt.status !== 'success') {
      // Revert: nonce unconsumed on-chain → release per spec §8.1 step 16.
      await release(store, key, claimed)
      throw new Errors.VerificationFailedError({
        ...(challengeId && { id: challengeId }),
        reason: `permit2 settlement reverted on-chain (status=${receipt.status})`,
      })
    }

    // receipt.status === 'success' → Permit2 nonce IS now consumed
    // on-chain. Enter terminal phase: subsequent markRejected (log
    // mismatch) or markConsumed (full success) MUST stick. Safety-net
    // release is locked out — auto-releasing here would re-admit a
    // credential whose Permit2 nonce is burned → user resubmits → Permit2
    // contract rejects "nonce already used" → confusing retry storm
    // (and replay-state lies about a payment that already settled).
    terminalPhase = true

    // ── Step 17: Transfer log strict match (ordered) ────────────────────
    // After receipt.status === 'success' the nonce IS consumed on-chain;
    // mismatch here must be markRejected (NOT release) per spec §8.1.
    const transferLogs = parseEventLogs({
      abi: TRANSFER_EVENT_ABI,
      eventName: 'Transfer',
      logs: receipt.logs,
    })
    // Match ALL expected (currency, from=recoveredSigner, transferDetails[i].(to,amount))
    // in order. Real Permit2 emits Transfer events in the order it iterates
    // transferDetails.
    const signerLower = recoveredSigner.toLowerCase()
    let logIdx = 0
    for (let i = 0; i < expectedLen; i++) {
      const td = transferDetails[i]!
      const expectedTo = td.to.toLowerCase()
      const expectedValue = BigInt(td.requestedAmount)
      // Find the next Transfer log matching (currency, from=signer, to, value).
      const found = transferLogs.findIndex(
        (log, j) =>
          j >= logIdx &&
          log.address.toLowerCase() === currencyLower &&
          log.args.from.toLowerCase() === signerLower &&
          log.args.to.toLowerCase() === expectedTo &&
          log.args.value === expectedValue,
      )
      if (found === -1) {
        await markRejected(
          store,
          key,
          `Transfer log mismatch at expected index ${i} (to=${td.to} value=${td.requestedAmount}); nonce consumed`,
        )
        throw new Errors.VerificationFailedError({
          ...(challengeId && { id: challengeId }),
          reason: `no matching Transfer event for transferDetails[${i}] (to=${td.to} value=${td.requestedAmount})`,
        })
      }
      logIdx = found + 1
    }

    // ── Step 18: mark consumed ──────────────────────────────────────────
    // The payment settled on-chain and the Transfer logs matched — the
    // payer has paid. A store failure here must NOT surface as an error
    // to a paid payer: consumeSlotBestEffort retries the write and warns
    // instead of throwing; the slot staying inflight already blocks
    // replay, and the receipt is their proof of the payment that happened.
    await consumeSlotBestEffort(store, key, '[verifyPermit2]')

    // ── Step 19: build receipt ──────────────────────────────────────────
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
    // Safety net for unexpected errors that bypass our explicit
    // release/markRejected handling (see handleVerifierFailure).
    //
    // If `terminalPhase` is set, the Permit2 nonce IS consumed
    // on-chain and a terminal store-write was in flight. Releasing here
    // would re-admit a credential whose nonce is burned — the next
    // reserve+verify would re-execute the Permit2 contract call, which
    // would revert "InvalidNonce", and the user would see a misleading
    // error. Keep the slot inflight — reserve() reclaims it after
    // inflightTtlMs and the retry re-checks on-chain nonce state.
    return await handleVerifierFailure({
      err,
      store,
      key,
      token: claimed,
      terminalPhase,
      label: '[verifyPermit2]',
      cleanupNoun: 'cleanup',
    })
  }
}
