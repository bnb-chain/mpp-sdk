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
 *        → release on fail
 *    16. writeContract → waitForTransactionReceipt. Broadcast failure →
 *        release; timeout → keep inflight (TTL); revert → release (nonce
 *        unconsumed on-chain).
 *    17. parseEventLogs(Transfer) strictly matches ALL expected transfers
 *        (currency, recoveredSigner-as-from, each (to, value) pair in order).
 *        Mismatch → markRejected (nonce IS consumed on-chain; permanent).
 *    18. Replay.markConsumed.
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
  compactSignatureToSignature,
  encodeAbiParameters,
  keccak256,
  parseCompactSignature,
  parseEventLogs,
  serializeSignature,
  toBytes,
} from 'viem'

import {
  PERMIT2_WITNESS_TYPE_STRING,
  computeChallengeHash,
  permit2BatchTypes,
  permit2Domain,
  permit2SingleTypes,
} from '../protocol/TypedData.js'
import { type EvmReceipt, buildEvmReceipt } from './Receipt.js'
import {
  type ChargeStore,
  getReplaySlot,
  markConsumed,
  markRejected,
  permit2Key,
  release,
  reserve,
} from './Replay.js'

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
  const { publicClient, store, chainId, settlementSigner } = ctx
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

  // Normalize EIP-2098 compact (64-byte) signatures to
  // standard r||s||v (65-byte) form. The wire schema (Methods.ts
  // `evmSignature`) accepts both lengths, but viem's recoverTypedDataAddress
  // AND the Permit2 contract's permitWitnessTransferFrom both REQUIRE
  // the 65-byte form. Without normalization a spec-compliant compact
  // sig produces "invalid signature length" at step 10 (verifier) AND
  // at step 16 (contract call) — both rejections.
  //
  // The single `normalizedSignature` value flows downstream to both the
  // recover path here and the simulate/writeContract paths at step 16.
  // 130 hex chars (incl. 0x prefix) = 64 bytes = compact; 132 = 65 bytes
  // = standard (we count payload bytes via length-2 to drop the 0x).
  const sigHexLen = signature.length - 2
  const normalizedSignature: Hex =
    sigHexLen === 128
      ? serializeSignature(compactSignatureToSignature(parseCompactSignature(signature)))
      : signature

  // Build the typed-data message reading from credential.payload. nonce +
  // deadline are uint256 represented as decimal strings → BigInt.
  let recoveredSigner: Address
  try {
    // Recover the expected signer by trying both single and batch typed
    // data shapes. Use credential.source to short-circuit if possible.
    // Note: verifyTypedData (viem) requires `address` arg = candidate signer.
    // We need to RECOVER the signer first; verifyTypedData returns boolean.
    // viem has `recoverTypedDataAddress` for recovery.
    const { recoverTypedDataAddress } = await import('viem')
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
  if (credential.source === undefined) {
    throw new Errors.VerificationFailedError({
      ...(challengeId && { id: challengeId }),
      reason: `permit2 requires credential.source (draft §6.1): expected 'did:pkh:eip155:${chainId}:${recoveredSigner}'`,
    })
  }
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
      reason: `credential.source (${sourceMatch[1]}) does not match recovered Permit2 signer (${recoveredSigner})`,
    })
  }

  // ── Step 12: atomic reserve ───────────────────────────────────────────
  const key = permit2Key(chainId, permit2Address, recoveredSigner, permit.nonce)
  const claimed = await reserve(store, key)
  if (!claimed) {
    // Normalized read so a backend failure surfaces as
    // ReplayStoreUnavailableError instead of raw Redis/Postgres error.
    const current = await getReplaySlot(store, key)
    const reasonText =
      current?.state === 'consumed'
        ? `permit2 credential already consumed (signer=${recoveredSigner}, nonce=${permit.nonce})`
        : current?.state === 'rejected'
          ? `permit2 credential previously rejected: ${current.reason ?? 'unknown'}`
          : `concurrent verify in progress for permit2 credential (signer=${recoveredSigner}, nonce=${permit.nonce})`
    throw new Errors.VerificationFailedError({
      ...(challengeId && { id: challengeId }),
      reason: reasonText,
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
    // ── Step 13: balanceOf ──────────────────────────────────────────────
    const balance = (await publicClient.readContract({
      address: currency,
      abi: ERC20_READ_ABI,
      functionName: 'balanceOf',
      args: [recoveredSigner],
    })) as bigint
    if (balance < totalAmount) {
      await release(store, key)
      throw new Errors.VerificationFailedError({
        ...(challengeId && { id: challengeId }),
        reason: `signer balance ${balance} < totalAmount ${totalAmount}`,
      })
    }

    // ── Step 14: allowance(signer, permit2Address) ──────────────────────
    const allowance = (await publicClient.readContract({
      address: currency,
      abi: ERC20_READ_ABI,
      functionName: 'allowance',
      args: [recoveredSigner, permit2Address],
    })) as bigint
    if (allowance < totalAmount) {
      await release(store, key)
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
        // simulate first
        await publicClient.simulateContract({
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
          ...baseArgs,
          chain: settlementSigner.chain ?? null,
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
        await publicClient.simulateContract({
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
          ...baseArgs,
          chain: settlementSigner.chain ?? null,
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
      }
    } catch (settleErr) {
      // simulate or broadcast failed before any on-chain state change.
      // Nonce is unconsumed; release so the client can retry.
      await release(store, key)
      throw new Errors.VerificationFailedError({
        ...(challengeId && { id: challengeId }),
        reason: `permit2 simulate/broadcast failed: ${settleErr instanceof Error ? settleErr.message : String(settleErr)}`,
      })
    }

    // Wait for receipt
    let receipt: Awaited<ReturnType<PublicClient['waitForTransactionReceipt']>>
    try {
      receipt = await publicClient.waitForTransactionReceipt({ hash: txHash })
    } catch (waitErr) {
      // Timeout — keep inflight per spec §8.1 step 16; TTL handles cleanup.
      throw new Errors.VerificationFailedError({
        ...(challengeId && { id: challengeId }),
        reason: `permit2 waitForTransactionReceipt failed; slot remains inflight (TTL cleanup): ${
          waitErr instanceof Error ? waitErr.message : String(waitErr)
        }`,
      })
    }

    if (receipt.status !== 'success') {
      // Revert: nonce unconsumed on-chain → release per spec §8.1 step 16.
      await release(store, key)
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
    await markConsumed(store, key)

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
    // release/markRejected handling. If the slot is still inflight,
    // release it so the user can retry.
    //
    // The secondary store.get/release calls here MUST NOT
    // mask the original `err`. If the store backend itself is the cause
    // of `err` (e.g. earlier reserve() threw ReplayStoreUnavailableError),
    // these cleanup calls will throw too — swallow+log them so the user
    // sees the original failure.
    //
    // If `terminalPhase` is set, the Permit2 nonce IS consumed
    // on-chain and a terminal store-write was in flight. Releasing here
    // would re-admit a credential whose nonce is burned — the next
    // reserve+verify would re-execute the Permit2 contract call, which
    // would revert "InvalidNonce", and the user would see a misleading
    // error. Keep the slot inflight; TTL or operator handles cleanup.
    if (err instanceof Errors.VerificationFailedError) throw err
    if (terminalPhase) {
      // eslint-disable-next-line no-console -- terminal-phase operator hint
      console.warn(
        '[verifyPermit2] terminal-phase store write failed; slot remains inflight ' +
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
        '[verifyPermit2] safety-net cleanup failed; original error takes precedence:',
        cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      )
    }
    throw err
  }
}
