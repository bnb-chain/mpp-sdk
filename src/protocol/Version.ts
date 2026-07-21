/**
 * Frozen identifiers that pin this SDK to the upstream mppx + draft sources
 * it was implemented against. Surfaced for spec compliance reporting,
 * downstream debugging, and supply-chain provenance.
 *
 * Update these together with package.json `version`, AGENTS.md, and the
 * `Spec Compliance` README section whenever the SDK is bumped.
 */

/**
 * IETF EVM Charge draft this SDK targets byte-for-byte.
 * Updates to a newer draft revision require coordinated changes to
 * src/Methods.ts, src/protocol/TypedData.ts, and the verifier sources
 * under src/server/.
 */
export const DRAFT_VERSION = 'draft-evm-charge-00' as const

/** Canonical URL for the draft text — used in error messages / docs. */
export const DRAFT_URL = 'https://paymentauth.org/draft-evm-charge-00.html' as const

/**
 * The mppx git commit SHA whose API surface this SDK was validated against.
 * A migration audit (2026-07-21) confirmed this snapshot's Method / Challenge /
 * Credential / Receipt / Store / Errors / zod helpers; later mppx releases
 * may diverge and SHOULD be re-validated.
 *
 * Bump only after re-running the §22 spike checklist and updating the
 * REWRITE-SPEC §22 baseline table.
 */
export const MPPX_SHA = 'b4334f0f0683930a1c9061d78de3a5255caaf962' as const

/**
 * Permit2 canonical deployment address (Uniswap Labs deterministic deployment).
 * SDK uses this as the default `methodDetails.permit2Address` when callers
 * don't override; verifiers MUST always read the wire value rather than this
 * constant (see spec §6.3 / §7).
 */
export const CANONICAL_PERMIT2_ADDRESS = '0x000000000022d473030f116ddee9f6b43ac78ba3' as const
