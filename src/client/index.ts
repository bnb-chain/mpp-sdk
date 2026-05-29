/**
 * `@bnb-chain/mpp/client` — client-side credential constructors.
 *
 * Each function in this barrel produces a serialized credential string
 * that is the COMPLETE `Authorization` header value — mppx's
 * `Credential.serialize` already prepends the `Payment ` scheme prefix.
 * Use it as-is:
 *
 *   const credential = await createHashCredential({ challenge, hash })
 *   fetch(url, { headers: { Authorization: credential } })
 *
 * Do NOT wrap the returned string with another `Payment ` prefix; that
 * would produce `Payment Payment <encoded>` and fail to deserialize.
 *
 * The caller obtains the inbound `Challenge` via mppx
 * (`Challenge.fromHeaders` / `Challenge.deserialize`) from the server's
 * 402 response, then invokes one of the four constructors below
 * depending on which credential type the server advertised in
 * `methodDetails.credentialTypes`.
 *
 * Per-credential signing inputs:
 *
 *   - hash          — no signing; just `txHash` of a previously-made
 *                     on-chain transfer.
 *   - transaction   — signs a full EIP-1559 `transfer(recipient, amount)`
 *                     calldata against the curated ERC-20.
 *   - permit2       — signs an EIP-712 Permit2 PermitWitnessTransferFrom
 *                     (or PermitBatchWitnessTransferFrom for splits)
 *                     against the EIP-712 domain built from
 *                     `challenge.request.methodDetails.permit2Address`
 *                     (NOT a canonical / global Permit2
 *                     fallback — spec §6.3 / §8.1 require the wire
 *                     `permit2Address` to be the single source of
 *                     truth so forks / mirror Permit2 deployments work
 *                     without a per-chain compiled-in table).
 *   - authorization — signs an EIP-712 EIP-3009 TransferWithAuthorization
 *                     against the curated token domain (USDC, etc.).
 *
 * `methodDetails.credentialTypes` advertised by the server is the
 * source of truth on which credential types the deployment accepts;
 * clients pick one and call the matching constructor.
 *
 * ## §11 unified `charge(params)` factory: DEFERRED to v1.1
 *
 * Spec §11 specifies a high-level `charge(params)` factory built on
 * `Method.toClient(chargeMethod, ...)` that auto-selects the credential
 * type by `priorityOrder` and lifts caller-supplied `account` / `rpcUrl`
 * into nonce / allowance / chainId reads. v1.0.0 ships only the four
 * low-level constructors below. The SAFETY half of §11.2 (default
 * accepted-set is `['transaction', 'hash']` when the server omits
 * `methodDetails.credentialTypes`) is enforced HERE in v1.0.0 by every
 * low-level constructor — see `src/client/internal/AssertChallenge.ts`
 * `parseEvmChargeChallenge` + `assertCredentialTypeAccepted`. Only the
 * ergonomic auto-selection + capability matrix is deferred.
 *
 * Until v1.1 lands, callers do:
 *
 *   import { Challenge } from 'mppx'
 *   import { createPermit2Credential } from '@bnb-chain/mpp/client'
 *   const challenge = Challenge.deserialize(authHeader)
 *   const credential = await createPermit2Credential({ challenge, account, ... })
 *
 * The decision to defer was scope: the auto-selection layer requires
 * viem `PublicClient` integration for nonce / allowance / chainId reads
 * across all four credential types (~200-300 LOC + RPC mocking in tests),
 * which is a non-trivial follow-up. The shipped low-level constructors
 * cover every credential type with full wire validation today.
 */

export { type CreateHashCredentialOptions, createHashCredential } from './Hash.js'

export {
  type CreateTransactionCredentialOptions,
  createTransactionCredential,
} from './Transaction.js'

export {
  type CreatePermit2CredentialOptions,
  type Permit2Split,
  createPermit2Credential,
} from './Permit2.js'

export {
  type CreateAuthorizationCredentialOptions,
  createAuthorizationCredential,
} from './Authorization.js'
