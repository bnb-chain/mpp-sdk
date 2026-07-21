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
import { type ChargeStore, DEFAULT_INFLIGHT_TTL_MS } from '../Replay.js'
import { resolveSettlementSigner } from '../Settlement.js'
import type { PreflightInternalHooks, ResolvedChargeParams, ServerParameters } from './types.js'

/**
 * Sentinel value used by curated matrix entries whose real contract
 * address has not yet been pinned (e.g. `opbnb-testnet` `TEST_USDT`).
 * preflightCharge rejects this value unless an internal hook explicitly
 * allows it (see `PreflightInternalHooks.allowSentinelTokenAddress`).
 */
const SENTINEL_TOKEN_ADDRESS = '0x0000000000000000000000000000000000000000' as const

/**
 * viem's default `waitForTransactionReceipt` timeout — the receipt wait
 * the settling verifiers fall back to when `settlementTimeoutMs` is unset.
 */
const VIEM_DEFAULT_RECEIPT_TIMEOUT_MS = 180_000

/**
 * Safety margin the stale-inflight reclaim TTL must keep above the
 * receipt wait: worst-case mining delay + cross-pod clock skew. A slot
 * whose settlement is still inside `waitForTransactionReceipt` must never
 * become reclaimable — a retry would re-broadcast a settlement that may
 * still land (concurrent double-broadcast).
 */
const INFLIGHT_TTL_MARGIN_MS = 120_000

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
  // pinned (e.g. `opbnb-testnet` `TEST_USDT`) carry the sentinel
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

  // An explicit RPC override is an untrusted deployment boundary: viem's
  // configured `chain` metadata does not prove the remote endpoint serves
  // that chain. Permit2 is deployed at the same canonical address on many
  // networks, so a mere getCode probe can pass even when the endpoint is for
  // the wrong chain; token reads then fail only on the first paid request.
  // Pin the remote eth_chainId at boot without echoing rpcUrl (it may contain
  // an API key).
  if (rpcUrl !== undefined) {
    let rpcChainId: number
    try {
      rpcChainId = await publicClient.getChainId()
    } catch (cause) {
      throw new Errors.InvalidChallengeError({
        reason:
          `params.rpcUrl chainId probe failed for expected chainId ${chainId}: ` +
          `${cause instanceof Error ? cause.message : String(cause)}`,
      })
    }
    if (rpcChainId !== chainId) {
      throw new Errors.InvalidChallengeError({
        reason:
          `params.rpcUrl returned chainId ${rpcChainId}, expected ${chainId} for ` +
          `chain="${chain}". Refusing to issue challenges against a mismatched RPC.`,
      })
    }
  }

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

  // Validate the settlement-timing pair BEFORE it reaches reserve() /
  // the settling verifiers. `inflightTtlMs <= 0` makes EVERY inflight
  // slot instantly 'stale' — reserve()'s reclaim branch then lets a
  // concurrent retry double-broadcast the settlement. `NaN` poisons the
  // `Date.now() - ts >= ttl` staleness comparison to always-false,
  // disabling reclaim forever (stranded slots never recover). And an
  // inflightTtlMs that does not comfortably exceed the receipt wait lets
  // a retry reclaim a slot whose settlement is still inside
  // waitForTransactionReceipt. Reject at the boundary.
  if (params.settlementTimeoutMs !== undefined) {
    const t = params.settlementTimeoutMs
    if (!Number.isInteger(t) || t <= 0 || t > Number.MAX_SAFE_INTEGER) {
      throw new Errors.InvalidChallengeError({
        reason:
          `params.settlementTimeoutMs must be a positive safe integer (milliseconds); ` +
          `got ${String(t)}. Pass undefined to use viem's default receipt-wait timeout ` +
          `(${VIEM_DEFAULT_RECEIPT_TIMEOUT_MS}ms).`,
      })
    }
  }
  if (params.inflightTtlMs !== undefined) {
    const v = params.inflightTtlMs
    if (!Number.isInteger(v) || v <= 0 || v > Number.MAX_SAFE_INTEGER) {
      throw new Errors.InvalidChallengeError({
        reason:
          `params.inflightTtlMs must be a positive safe integer (milliseconds); ` +
          `got ${String(v)}. Pass undefined to use the default ` +
          `(${DEFAULT_INFLIGHT_TTL_MS}ms, DEFAULT_INFLIGHT_TTL_MS in Replay.ts).`,
      })
    }
  }
  // Margin check runs on the EFFECTIVE values so a large
  // settlementTimeoutMs paired with the default TTL is caught too.
  const effectiveReceiptWaitMs = params.settlementTimeoutMs ?? VIEM_DEFAULT_RECEIPT_TIMEOUT_MS
  const effectiveInflightTtlMs = params.inflightTtlMs ?? DEFAULT_INFLIGHT_TTL_MS
  if (effectiveInflightTtlMs < effectiveReceiptWaitMs + INFLIGHT_TTL_MARGIN_MS) {
    throw new Errors.InvalidChallengeError({
      reason:
        `params.inflightTtlMs must be >= (params.settlementTimeoutMs ?? ` +
        `${VIEM_DEFAULT_RECEIPT_TIMEOUT_MS}) + ${INFLIGHT_TTL_MARGIN_MS} — viem's default ` +
        `receipt-wait timeout plus a worst-case mining-delay margin. Got ` +
        `inflightTtlMs=${effectiveInflightTtlMs}ms` +
        `${params.inflightTtlMs === undefined ? ' (default)' : ''}, required >= ` +
        `${effectiveReceiptWaitMs + INFLIGHT_TTL_MARGIN_MS}ms. A shorter TTL lets a retry ` +
        `reclaim a slot whose settlement is still inside waitForTransactionReceipt ` +
        `(concurrent double-broadcast).`,
    })
  }

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
    // Fail at boot, not on every challenge issuance: the wire schema
    // (Methods.ts) enforces minLength(1)/maxLength(10) on splits and a
    // strict sum(splits) < amount invariant — a factory config violating
    // either would otherwise pass preflight and then throw a zod error on
    // EVERY route invocation.
    if (splits.length === 0) {
      throw new Errors.InvalidChallengeError({
        reason:
          'splits: [] is invalid — the wire schema requires at least 1 entry when splits is ' +
          'present (spec §4.2.3); omit the field entirely for a no-splits deployment',
      })
    }
    if (splits.length > 10) {
      throw new Errors.InvalidChallengeError({
        reason: `splits has ${splits.length} entries — the wire schema caps at 10 (spec §4.2.3)`,
      })
    }
    if (params.amount !== undefined) {
      const splitsSum = splits.reduce((sum, s) => sum + BigInt(s.amount), 0n)
      if (splitsSum >= BigInt(params.amount)) {
        throw new Errors.InvalidChallengeError({
          reason:
            `sum(splits[].amount) = ${splitsSum} must be strictly less than amount ` +
            `${params.amount} (spec §4.2.3: the primary recipient must receive a positive share)`,
        })
      }
    }
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
  // A `settleBackend` that covers `authorization` settles it
  // without a local signer. permit2 always settles locally, so it still needs one.
  const backendCoversAuth = params.settleBackend?.settles.includes('authorization') ?? false
  const needsSigner =
    resolvedCredentialTypes.includes('permit2') ||
    (resolvedCredentialTypes.includes('authorization') && !backendCoversAuth)
  const settlementSigner = resolveSettlementSigner(params, {
    viemChain,
    transportUrl,
    chainId,
  })
  if (needsSigner && !settlementSigner) {
    throw new Errors.InvalidChallengeError({
      reason:
        'permit2/authorization require settlementAccount or settlementWalletClient ' +
        '(or a settleBackend covering authorization); ' +
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
      settleBackend: params.settleBackend,
      store,
      verifyChallengeBinding,
      confirmations,
      eip712,
    },
  }
}
