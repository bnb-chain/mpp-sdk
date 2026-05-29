/**
 * preflightCharge — async RPC + curated resolution for the EVM Charge
 * server factory (spec §10).
 *
 *   preflightCharge(params)  async — does all RPC + curated resolution.
 *                            Returns ResolvedChargeParams (params + _resolved
 *                            bag). Throws on misconfiguration before any
 *                            verifier ever runs (Permit2 not deployed +
 *                            user required it, credentialTypes empty,
 *                            authorization on non-EIP-3009 token, etc.).
 *
 * Test seams (Permit2 probe stub, publicClient override, sentinel
 * bypass) live on the unexported `preflightChargeInternal` which
 * `test/helpers/server/preflightChargeForTest` imports directly. Production callers
 * cannot bypass any preflight guard.
 */

import { Errors } from 'mppx'
import { type PublicClient, createPublicClient, http } from 'viem'

import { type CredentialType } from '../../Methods.js'
import { CANONICAL_PERMIT2_ADDRESS } from '../../protocol/Version.js'
import { makeVerifyChallengeBinding } from '../ChallengeBinding.js'
import {
  curatedDefaultConfirmations,
  curatedRpcUrl,
  curatedViemChain,
  getAcceptedCredentialTypes,
  getCuratedEip712Domain,
  isCuratedEip3009Supported,
  resolveCuratedChainId,
  resolveCuratedTokenAddress,
  resolveCuratedTokenDecimals,
} from '../curated.js'
import { type ChargeStore } from '../Replay.js'
import { resolveSettlementSigner } from '../Settlement.js'
import type { PreflightInternalHooks, ResolvedChargeParams, ServerParameters } from './types.js'

/**
 * Sentinel value used by curated matrix entries whose real contract
 * address has not yet been pinned (e.g. `bsc-testnet` `TEST_USDT`).
 * preflightCharge rejects this value unless an internal hook explicitly
 * allows it (see `PreflightInternalHooks.allowSentinelTokenAddress`).
 */
const SENTINEL_TOKEN_ADDRESS = '0x0000000000000000000000000000000000000000' as const

/**
 * Default Permit2 deployment probe: `eth_getCode(address) != '0x'`. Mocked
 * out in tests via `preflightChargeForTest` so unit tests don't hit RPC.
 */
async function defaultIsContractDeployed(
  publicClient: PublicClient,
  address: `0x${string}`,
): Promise<boolean> {
  const code = await publicClient.getCode({ address })
  return code !== undefined && code !== '0x'
}

/**
 * Public preflight API — single-arg. Does all RPC + curated resolution.
 *
 * Test seams (Permit2 probe stub, publicClient override, sentinel
 * bypass) are intentionally NOT exposed here; they live on the
 * unexported `preflightChargeInternal` which `test/helpers/server/preflightChargeForTest`
 * imports directly. Production callers cannot bypass any preflight guard.
 */
export async function preflightCharge(params: ServerParameters): Promise<ResolvedChargeParams> {
  return preflightChargeInternal(params, {})
}

/**
 * @internal — test-only entry point. Accepts `PreflightInternalHooks` for
 * stubbing network probes / overriding the publicClient / bypassing the
 * sentinel zero-address guard. NOT exported from `@bnb-chain/mpp/server`.
 *
 * `test/helpers/server/preflightChargeForTest.ts` is the ONLY allowed
 * caller. Production code MUST use `preflightCharge(params)` above.
 */
export async function preflightChargeInternal(
  params: ServerParameters,
  hooks: PreflightInternalHooks = {},
): Promise<ResolvedChargeParams> {
  // —— 0: destructure + curated resolve ——
  const { chain, token, splits, rpcUrl, chainOverride } = params
  const currency = resolveCuratedTokenAddress(chain, token)
  const decimals = resolveCuratedTokenDecimals(chain, token)
  const chainId = resolveCuratedChainId(chain)
  const permit2Address = params.permit2Address ?? CANONICAL_PERMIT2_ADDRESS

  // —— Reject sentinel zero-address tokens (placeholder curated entries) ——
  //
  // Curated entries whose real verified contract address has not been
  // pinned (e.g. `bsc-testnet` `TEST_USDT`) carry the sentinel
  // 0x000...000 — `resolveCuratedTokenAddress` returns it as-is. Without
  // this guard a deployment could happily emit zero-address `currency` on
  // the wire and pretend nothing's wrong. The test seam
  // `allowSentinelTokenAddress` lets live-test scaffolds opt in for a
  // specific scenario; production MUST leave it unset.
  if (!hooks.allowSentinelTokenAddress && currency.toLowerCase() === SENTINEL_TOKEN_ADDRESS) {
    throw new Errors.InvalidChallengeError({
      reason:
        `(chain="${chain}", token="${token}") resolves to sentinel zero address ` +
        `(${SENTINEL_TOKEN_ADDRESS}). The curated matrix entry is a placeholder — ` +
        `pin a real verified token contract in src/server/curated.ts before live use.`,
    })
  }

  // —— chainOverride.id guard: prevents covert BYO chain via override ——
  if (chainOverride !== undefined && chainOverride.id !== chainId) {
    throw new Errors.InvalidChallengeError({
      reason:
        `chainOverride.id (${chainOverride.id}) must equal the selected ` +
        `SupportedChainPreset chainId (${chainId})`,
    })
  }

  const viemChain = chainOverride ?? curatedViemChain(chain)
  const transportUrl = rpcUrl ?? curatedRpcUrl(chain)
  const publicClient =
    hooks.publicClientOverride ??
    createPublicClient({
      chain: viemChain,
      transport: http(transportUrl),
    })
  // Validate `confirmations` BEFORE it reaches Hash/Transaction
  // verifiers. The verifiers compare `txConfirmations < BigInt(confirmations)`
  // — if `confirmations` is `-1`, BigInt(-1) makes the check trivially
  // false (txConfirmations is always >= 0), silently bypassing the
  // confirmations requirement. `NaN` / fractional values throw raw
  // `RangeError` / `SyntaxError` from BigInt() inside the verifier hot
  // path, which is hard to debug operationally. Reject at the boundary.
  if (params.confirmations !== undefined) {
    const c = params.confirmations
    if (!Number.isInteger(c) || c < 0 || c > Number.MAX_SAFE_INTEGER) {
      throw new Errors.InvalidChallengeError({
        reason:
          `params.confirmations must be a non-negative safe integer; got ${String(c)}. ` +
          `Pass undefined to use the curated default for the chain ` +
          `(curatedDefaultConfirmations: see src/server/curated.ts).`,
      })
    }
  }
  const confirmations = params.confirmations ?? curatedDefaultConfirmations(chain)

  // Validate `hashFromPolicy` (spec §8.4). The Hash verifier
  // only checks `=== 'strict_from'` and falls through to lax behavior
  // for anything else — a typo like `'strict'` would silently disable
  // source binding (the security check this policy gates). Make the
  // typo a hard error so misconfiguration is caught at startup.
  if (
    params.hashFromPolicy !== undefined &&
    params.hashFromPolicy !== 'strict_from' &&
    params.hashFromPolicy !== 'lax_from'
  ) {
    throw new Errors.InvalidChallengeError({
      reason:
        `params.hashFromPolicy must be 'strict_from' | 'lax_from' (or undefined ` +
        `for the 'lax_from' default); got ${JSON.stringify(params.hashFromPolicy)}. ` +
        `A typo here would silently degrade to lax_from and disable the source-binding ` +
        `check (spec §8.4).`,
    })
  }

  // —— Replay store resolve (presence-only check) ——————————————————————————
  //
  // Spec §9 is normative: production deployments MUST pass a durable atomic
  // store (Redis / Postgres / Cloudflare KV). `Store.memory()` is process-
  // local — replay protection silently becomes per-pod on a multi-node
  // rollout, masking a real double-spend class.
  //
  // What the SDK can verify: that the caller passed `params.store` at all.
  // What the SDK CANNOT verify: whether the supplied store is actually
  // durable across processes / pods. Any object that satisfies the
  // `ChargeStore` interface — a Redis client, a Postgres handle, or a
  // bare Map wrapper — typechecks. We deliberately do NOT brand the auto-
  // memory store and check the brand on user-supplied stores: that
  // approach gave the false impression of catching explicit
  // `store: Store.memory()` from user code, when in fact the brand only
  // covered the SDK-auto-defaulted instance. We replace that
  // half-measure with an honest presence-only check + clear docs.
  //
  // Behavior matrix:
  //   - 'production' + omitted        → throw (deployment MUST pass a
  //                                            durable atomic store;
  //                                            SDK trusts the claim)
  //   - 'production' + any store      → accepted presence-only
  //                                     (SDK can't verify durability)
  //   - 'test'                        → silent default to memory
  //   - everything else (dev / unset) → memory + one-time console.warn
  //
  // Note: the SDK does NOT endorse `Store.memory()` as a
  // production option. It can't structurally distinguish a Redis client
  // from a Map, so a deployment that explicitly passes `Store.memory()`
  // under `NODE_ENV=production` slips through the presence check — but
  // that's a violation of spec §9 (process-local store forbidden in
  // production), not a sanctioned escape hatch. For local / single-process
  // experiments, run with a non-`production` `NODE_ENV` instead; the dev
  // path defaults to memory and emits the visible warn that flags the
  // gap before any deploy cutover.
  const nodeEnv =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- process.env shape varies (Node vs edge)
    typeof process !== 'undefined' && (process as any).env
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ((process as any).env.NODE_ENV as string | undefined)
      : undefined
  let store: ChargeStore
  if (params.store !== undefined) {
    store = params.store as ChargeStore
  } else {
    if (nodeEnv === 'production') {
      throw new Errors.InvalidChallengeError({
        reason:
          'preflightCharge: params.store is REQUIRED when NODE_ENV=production ' +
          '(spec §9). Pass a durable atomic store (Redis / Postgres / Cloudflare KV); ' +
          "the SDK trusts the supplied store is durable — it can't structurally " +
          'verify that across the FFI boundary. For local / single-process ' +
          'experiments, run with a non-`production` NODE_ENV (dev / unset both ' +
          'default to Store.memory() with a one-time warn).',
      })
    }
    const { Store } = await import('mppx')
    if (nodeEnv !== 'test') {
      // Visible warn in dev so the developer notices BEFORE the production
      // deploy hits the throw above. Once per process — preflight is called
      // once at server startup, so this naturally doesn't repeat per request.
      // eslint-disable-next-line no-console -- intentional one-shot startup warn
      console.warn(
        '[preflightCharge] params.store omitted; defaulting to Store.memory() ' +
          '(in-process replay protection only). Production deployments MUST pass a ' +
          'durable atomic store — see spec §9.',
      )
    }
    store = Store.memory() as ChargeStore
  }

  // —— credentialTypes empty-array early reject ——
  if (params.credentialTypes !== undefined && params.credentialTypes.length === 0) {
    throw new Errors.InvalidChallengeError({
      reason: 'credentialTypes must not be empty',
    })
  }

  // —— authorization gate: only enabled if curated matrix marks EIP-3009 ——
  if (params.credentialTypes?.includes('authorization')) {
    if (!isCuratedEip3009Supported(chain, token)) {
      throw new Errors.InvalidChallengeError({
        reason:
          `'authorization' credential is not supported for (${chain}, ${token}) — ` +
          'curated matrix marks eip3009Supported=false',
      })
    }
  }

  // —— splits / credentialTypes algorithm ——
  const baseCredentialTypes = getAcceptedCredentialTypes(chain, token)
  if (params.credentialTypes !== undefined) {
    const base = new Set(baseCredentialTypes)
    for (const t of params.credentialTypes) {
      if (!base.has(t)) {
        throw new Errors.InvalidChallengeError({
          reason: `credentialType '${t}' is not in the curated allowlist for (${chain}, ${token})`,
        })
      }
    }
  }
  let resolvedCredentialTypes: readonly CredentialType[] =
    params.credentialTypes ?? baseCredentialTypes

  if (splits !== undefined) {
    if (!baseCredentialTypes.includes('permit2')) {
      throw new Errors.InvalidChallengeError({
        reason: `splits require permit2 credential support; (${chain}, ${token}) has none`,
      })
    }
    if (
      params.credentialTypes !== undefined &&
      params.credentialTypes.some((t) => t !== 'permit2')
    ) {
      throw new Errors.InvalidChallengeError({
        reason: "splits require credentialTypes to be exactly ['permit2']",
      })
    }
    resolvedCredentialTypes = ['permit2']
  }

  // —— Permit2 deployment probe (BEFORE settlement signer check) ——
  const userRequestedPermit2 = params.credentialTypes?.includes('permit2') ?? false
  const isContractDeployed = hooks.isContractDeployed ?? defaultIsContractDeployed

  if (resolvedCredentialTypes.includes('permit2')) {
    const deployed = await isContractDeployed(publicClient, permit2Address)
    if (!deployed) {
      if (splits !== undefined || userRequestedPermit2) {
        throw new Errors.InvalidChallengeError({
          reason:
            `Permit2 not deployed at ${permit2Address}` +
            (splits
              ? ' (splits require permit2)'
              : ' (credentialTypes explicitly required permit2)'),
        })
      }
      resolvedCredentialTypes = resolvedCredentialTypes.filter((t) => t !== 'permit2')
    }
  }

  // —— Settlement signer (AFTER Permit2 probe — otherwise we'd require signer
  //    in cases where Permit2 ended up removed from the resolved set) ——
  const needsSigner =
    resolvedCredentialTypes.includes('permit2') || resolvedCredentialTypes.includes('authorization')
  const settlementSigner = resolveSettlementSigner(params, {
    viemChain,
    transportUrl,
    chainId,
  })
  if (needsSigner && !settlementSigner) {
    throw new Errors.InvalidChallengeError({
      reason:
        'permit2/authorization require settlementAccount or settlementWalletClient; ' +
        "or restrict credentialTypes to ['transaction', 'hash']",
    })
  }

  // —— Challenge binding helper closure (captures secretKey + mode) ——
  const verifyChallengeBinding = makeVerifyChallengeBinding(params.challengeBinding)

  // —— Resolve curated EIP-712 domain iff authorization is in the resolved
  //    credential set. getCuratedEip712Domain throws when the matrix lacks
  //    EIP-3009 support — preflightCharge's authorization gate above already
  //    rejected those, so this call is safe by precondition.
  const eip712: { readonly name: string; readonly version: string } | undefined =
    resolvedCredentialTypes.includes('authorization')
      ? getCuratedEip712Domain(chain, token)
      : undefined

  return {
    ...params,
    _resolved: {
      currency,
      decimals,
      chainId,
      permit2Address,
      resolvedCredentialTypes,
      publicClient,
      transportUrl,
      viemChain,
      settlementSigner,
      store,
      verifyChallengeBinding,
      confirmations,
      eip712,
    },
  }
}
