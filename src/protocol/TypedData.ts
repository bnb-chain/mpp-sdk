/**
 * EIP-712 typed-data definitions for EVM Charge (draft-evm-charge-00 §5.2 + §5.3).
 *
 * Byte-for-byte alignment with the draft is critical — any drift in the type
 * strings, struct shapes, or domain fields produces signatures that won't
 * verify cross-implementation. Treat this file as a normative checkpoint and
 * change it only when the draft itself changes.
 *
 * Two normative invariants enforced here:
 *
 *   1. `PaymentWitness` contains exactly `{ bytes32 challengeHash;
 *      string externalId; }`. `externalId` is `""` when absent from the
 *      challenge request (draft §5.2.3).
 *
 *   2. Domain `verifyingContract` MUST come from
 *      `challenge.request.methodDetails.permit2Address` at runtime — NOT
 *      from `CANONICAL_PERMIT2_ADDRESS`. The constant is a server-factory
 *      default injection source only; execution truth always reads the wire.
 *      See `permit2Domain` comment.
 */

import { encodePacked, type Address, type Hex, keccak256 } from 'viem'

/* -------------------------------------------------------------------------- */
/*  Permit2 — single-permission                                               */
/* -------------------------------------------------------------------------- */

/**
 * EIP-712 type string for Permit2 PaymentWitness wrapping. The draft prose
 * prints a space after the field comma; EIP-712 canonical encodeType does
 * not. Permit2 must receive the canonical no-space form below or its on-chain
 * type hash diverges from wallet signatures (see docs/spec-compliance.md).
 *
 * Format: `<wrapper-type> witness)<inner-types-in-alphabetical-order>`
 *   - wrapper:  `PaymentWitness witness)`
 *   - inner #1: `PaymentWitness(bytes32 challengeHash,string externalId)`
 *   - inner #2: `TokenPermissions(address token,uint256 amount)`
 *
 * The string omits the `PermitWitnessTransferFrom` / `PermitBatchWitnessTransferFrom`
 * prefix because Permit2 concatenates that itself when computing the typed
 * data hash (see Permit2 source).
 */
export const PERMIT2_WITNESS_TYPE_STRING =
  'PaymentWitness witness)PaymentWitness(bytes32 challengeHash,string externalId)TokenPermissions(address token,uint256 amount)'

/**
 * Compute `witness.challengeHash` for a Permit2 PaymentWitness.
 *
 * draft §5.2: `challengeHash = keccak256(abi.encodePacked(challenge.id, challenge.realm))`.
 *
 * The same `(challengeId, realm)` pair flows through:
 *   - challenge.id binding (via stored-lookup exact-match or mppx HMAC, §8.0)
 *   - this hash baked into the user's Permit2 signature
 *
 * `externalId` is also carried directly in the witness; all other request
 * fields remain bound through the challenge id.
 */
export function computeChallengeHash(challengeId: string, realm: string): Hex {
  return keccak256(encodePacked(['string', 'string'], [challengeId, realm]))
}

/**
 * Permit2 EIP-712 struct definitions for a single-permission permit
 * (one `TokenPermissions` entry, no splits).
 *
 * primaryType MUST be 'PermitWitnessTransferFrom' when calling
 * viem.signTypedData / verifyTypedData with this types object — paired
 * with `permitWitnessTransferFrom` on-chain. Spec §18 reminder #9.
 */
export const permit2SingleTypes = {
  PermitWitnessTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'witness', type: 'PaymentWitness' },
  ],
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  PaymentWitness: [
    { name: 'challengeHash', type: 'bytes32' },
    { name: 'externalId', type: 'string' },
  ],
} as const

/* -------------------------------------------------------------------------- */
/*  Permit2 — batch (splits)                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Permit2 EIP-712 struct definitions for a batch permit (multiple
 * `TokenPermissions` entries, used for splits per draft §4.2.3).
 *
 * primaryType MUST be 'PermitBatchWitnessTransferFrom' here, paired with
 * `permitBatchWitnessTransferFrom` on-chain. Spec §18 reminder #9.
 */
export const permit2BatchTypes = {
  PermitBatchWitnessTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions[]' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'witness', type: 'PaymentWitness' },
  ],
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  PaymentWitness: [
    { name: 'challengeHash', type: 'bytes32' },
    { name: 'externalId', type: 'string' },
  ],
} as const

/* -------------------------------------------------------------------------- */
/*  Permit2 — EIP-712 domain                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Build the Permit2 EIP-712 domain for signing / verifying a permit.
 *
 * ⚠️ `permit2Address` MUST come from `challenge.request.methodDetails.permit2Address`
 *    at runtime — NOT from `protocol/Version.CANONICAL_PERMIT2_ADDRESS`.
 *    Spec §6.3 / §7 / §18 reminder #9. The canonical constant is a server-factory
 *    default injection source; on the verifier path it is wrong to read from
 *    a constant because:
 *      - draft Table 2 lists `permit2Address` as REQUIRED `methodDetails`;
 *      - deployments MAY override via `ServerParameters.permit2Address`
 *        (fork / private chain / self-deployed Permit2 mirror);
 *      - Permit2 domain.verifyingContract, ERC20.allowance(owner, spender),
 *        and the eventual writeContract target MUST all be the same address
 *        — split brain here yields signature failure + on-chain drift.
 */
export function permit2Domain(chainId: number, permit2Address: Address) {
  return {
    name: 'Permit2',
    chainId,
    verifyingContract: permit2Address,
  } as const
}

/* -------------------------------------------------------------------------- */
/*  EIP-3009 (transferWithAuthorization)                                      */
/* -------------------------------------------------------------------------- */

/**
 * EIP-3009 nonce for a charge credential.
 *
 * draft §5.3: `nonce = keccak256(abi.encodePacked(challenge.id, challenge.realm))`.
 * Mirrors the Permit2 challengeHash construction so the same (challengeId,
 * realm) pair binds both signature schemes — but EIP-3009 nonces are
 * 32-byte opaque identifiers per the EIP-3009 standard, not counters.
 */
export function eip3009Nonce(challengeId: string, realm: string): Hex {
  // Byte-identical to computeChallengeHash by spec design — alias rather
  // than duplicate so the two derivations can never drift.
  return computeChallengeHash(challengeId, realm)
}

/**
 * EIP-3009 EIP-712 struct: TransferWithAuthorization.
 *
 * Field set is fixed by the EIP-3009 standard — do not add fields.
 */
export const eip3009Types = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

/**
 * Build the EIP-3009 EIP-712 domain for a specific token contract.
 *
 * `tokenName` + `tokenVersion` come from `src/server/curated.ts`
 * `getCuratedEip712Domain()` (which throws if the curated entry lacks
 * EIP-3009 support — preventing the verifier from accidentally signing
 * a tokenless domain). `chainId` MUST match the wire chainId; `tokenAddress`
 * MUST equal `challenge.request.currency`.
 */
export function eip3009Domain(params: {
  tokenName: string
  tokenVersion: string
  chainId: number
  tokenAddress: Address
}) {
  return {
    name: params.tokenName,
    version: params.tokenVersion,
    chainId: params.chainId,
    verifyingContract: params.tokenAddress,
  } as const
}
