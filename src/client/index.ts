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
 * ## Two layers: low-level constructors + the `pay()` auto-selector
 *
 * The four constructors above are the low-level layer — you pick the
 * credential type and supply its signing inputs. On top of them,
 * `pay(url, { wallet, policy })` (exported below) is the §11-style
 * high-level entry: it fetches the 402, reads `account` / viem clients
 * for nonce / allowance / chainId / decimals, derives the offered routes
 * from `methodDetails.credentialTypes`, and auto-selects one by a
 * capability-and-policy filter (hard constraints filter, `mode` ranks,
 * empty → `NoAcceptableMethodError`). This is **Phase 1** of the
 * multi-rail Payment Offer Layer (`docs/adr/0003-payment-offer-layer.md`)
 * — today it covers the mpp credentials only; cross-rail (x402 / b402
 * facilitator) selection is the future phase.
 *
 * The SAFETY half of §11.2 (default accepted-set is
 * `['transaction', 'hash']` when the server omits
 * `methodDetails.credentialTypes`) is enforced in BOTH layers — by every
 * low-level constructor (`src/client/internal/AssertChallenge.ts`
 * `parseEvmChargeChallenge` + `assertCredentialTypeAccepted`) and by
 * `pay()`'s `deriveLogicalPaths`.
 *
 * Pick the layer by need:
 *
 *   // high-level — express intent, let the SDK route:
 *   import { pay } from '@bnb-chain/mpp/client'
 *   const { response } = await pay(url, { wallet, policy: { mode: 'prefer-gasless' } })
 *
 *   // low-level — you already know the credential type:
 *   import { Challenge } from 'mppx'
 *   import { createPermit2Credential } from '@bnb-chain/mpp/client'
 *   const challenge = Challenge.deserialize(authHeader)
 *   const credential = await createPermit2Credential({ challenge, account, ... })
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

// Phase-1 unified buyer surface (ADR-0003): pay(url, { wallet, policy }) over the
// mpp credentials. The pure deriveLogicalPaths/selectRoute are exported for reuse + tests.
export {
  type AssetId,
  type Eip712DomainMap,
  type LogicalPath,
  NoAcceptableMethodError,
  PaymentRejectedError,
  type PayMode,
  type PayOptions,
  type PayPolicy,
  type PayRequestInit,
  type PayResult,
  type RouteRejection,
  type RouteSelection,
  type SelectionContext,
  type WalletCapabilities,
  type WalletContext,
  deriveLogicalPaths,
  pay,
  selectRoute,
} from './pay/index.js'
