/**
 * Builds the mppx handlers for the charge-server example.
 *
 * The route-override guard (spec §10 / §14.10) only lets `amount` /
 * `description` / `externalId` vary per route — `credentialTypes` and `splits`
 * are config-time. So each scenario that changes those gets its OWN handler
 * (one configured charge method each; they can't share the `evm.charge` slot):
 *
 *   - base      the token's credential types (permit2/transaction/hash) + a
 *               settlement signer (server sponsors gas for permit2). Serves /api/article,
 *               /api/download, /api/tip.
 *   - split     base config + a configured platform-fee split → /api/split
 *               settles as a 2-entry Permit2 batch (merchant + fee).
 *   - hashOnly  transaction + hash ONLY, with NO settlement signer — fully
 *               payer-funded (the server never broadcasts a settlement tx, so
 *               a malicious token can't grief its gas). Serves /api/hash-only.
 *   - stored    stored-lookup challenge binding (§8.0.1): persists each issued
 *               challenge (rememberChallenge, via onChallengeCreated) and
 *               re-compares its canonical bytes at verify — an HMAC-free
 *               binding (draft §6 zero-deviation). Serves /api/stored/article.
 *
 * chargeAsync() is the sugar form of `charge(await preflightCharge(...))`:
 * curated chain/token resolution + Permit2 deployment probe + settlement-signer
 * resolution. All three configs resolve to the same `Method.Server` type.
 */

import {
  type ChallengeStore,
  chargeAsync,
  preflightCharge,
  rememberChallenge,
} from '@bnb-chain/mpp/server'
import { Store } from 'mppx'
import { Mppx } from 'mppx/server'

import type { ChargeServerConfig } from './config.js'

/** The charge method produced by `chargeAsync` (bsc-testnet / TEST_USDT). */
type ChargeMethod = Awaited<ReturnType<typeof chargeAsync>>

/** A fully-configured mppx handler mounting one charge method. */
export type ChargeHandler = Mppx.Mppx<readonly [ChargeMethod]>

/** The per-scenario handlers this server mounts. */
export interface ChargeHandlers {
  readonly base: ChargeHandler
  readonly split: ChargeHandler
  readonly hashOnly: ChargeHandler
  readonly stored: ChargeHandler
}

/**
 * Demo platform-fee recipient for /api/split. A real merchant configures its
 * own split recipients; this fixed placeholder just lets the example settle a
 * visible 2-way Permit2 batch on testnet. NOT a real fee address.
 */
const DEMO_SPLIT_FEE_RECIPIENT = '0x000000000000000000000000000000000000beef' as const
/** Platform fee taken on /api/split: 0.2 USDT (base units, 18 decimals). */
const DEMO_SPLIT_FEE_BASE_UNITS = '200000000000000000'

export async function createHandlers(config: ChargeServerConfig): Promise<ChargeHandlers> {
  // Optional custom RPC, spread into each config when set.
  const rpc = config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}

  // Replay store: omitted here, so each handler defaults to Store.memory()
  // (in-process, dev only). Production MUST use a durable atomic store
  // (draft §9) — see src/redisStore.ts for a Redis-backed one:
  //   store: createRedisChargeStore(new Redis(process.env.REDIS_URL!))

  // Challenge store for the stored-lookup handler (separate from the replay
  // store, §8.0.1). Memory here; production backs it with a durable store too.
  const challengeStore = Store.memory() as ChallengeStore

  const [base, split, hashOnly, stored] = await Promise.all([
    chargeAsync({
      chain: 'bsc-testnet',
      token: 'TEST_USDT',
      recipient: config.recipient,
      // The matrix credential types for bsc-testnet/TEST_USDT (a non-EIP-3009
      // BEP-20): ['permit2', 'transaction', 'hash']. Not passed explicitly so
      // the ordered preference list flows through unchanged.
      settlementAccount: config.settlementAccount,
      challengeBinding: { mode: 'mppx-managed' },
      ...rpc,
    }),
    chargeAsync({
      chain: 'bsc-testnet',
      token: 'TEST_USDT',
      recipient: config.recipient,
      settlementAccount: config.settlementAccount,
      // Splits are config-time (route override is forbidden, spec §10), so the
      // platform fee lives here. /api/split issues a Permit2 batch where the
      // primary recipient gets `amount - fee` and this recipient gets the fee.
      splits: [{ recipient: DEMO_SPLIT_FEE_RECIPIENT, amount: DEMO_SPLIT_FEE_BASE_UNITS }],
      challengeBinding: { mode: 'mppx-managed' },
      ...rpc,
    }),
    chargeAsync({
      chain: 'bsc-testnet',
      token: 'TEST_USDT',
      recipient: config.recipient,
      // transaction + hash only → the server never sponsors settlement gas, so
      // NO settlementAccount. preflight allows omitting it because neither path
      // broadcasts a settlement tx (the payer broadcasts / references one).
      credentialTypes: ['transaction', 'hash'],
      challengeBinding: { mode: 'mppx-managed' },
      ...rpc,
    }),
    chargeAsync({
      chain: 'bsc-testnet',
      token: 'TEST_USDT',
      recipient: config.recipient,
      settlementAccount: config.settlementAccount,
      // stored-lookup: the SDK persists each issued challenge and re-compares
      // its canonical bytes at verify. This is the draft §6 zero-deviation
      // path — HMAC-free, so the handler below is created WITHOUT a secretKey;
      // the challenge store IS the binding (a forged id simply isn't in it).
      challengeBinding: { mode: 'stored-lookup', challengeStore },
      ...rpc,
    }),
  ])

  // No secretKey: stored-lookup is the SOLE binding (no mppx HMAC layer), so
  // this is a true HMAC-free deployment — not HMAC + stored-lookup defense-in-
  // depth like it would be if a secret were passed here.
  const storedHandler = Mppx.create({ methods: [stored] })
  // Persist every issued challenge so stored-lookup can find it at verify.
  // onChallengeCreated fires on the 402-issuing route path, and mppx awaits
  // the handler before returning — so the remember lands before the client
  // ever sees the challenge.
  storedHandler.onChallengeCreated(async (ctx) => {
    await rememberChallenge(challengeStore, ctx.challenge)
  })

  return {
    base: Mppx.create({ methods: [base], secretKey: config.secret }),
    split: Mppx.create({ methods: [split], secretKey: config.secret }),
    hashOnly: Mppx.create({ methods: [hashOnly], secretKey: config.secret }),
    stored: storedHandler,
  }
}

/**
 * Public description of THIS server's deployment, served at `/api/config`.
 *
 * A browser client fetches this instead of hard-coding the server's
 * (chain, token) assumptions — the curated matrix is SDK-internal, so the
 * resolved wire values come from `preflightCharge(...)._resolved` (the SDK's
 * own resolution), never a second hand-maintained copy.
 */
/**
 * Per-route descriptor for `/api/config`. Each mounted route can differ in the
 * credential types it advertises, how its challenge is bound, whether it splits
 * settlement, and whether the server settles on-chain for it — so a single
 * deployment-wide summary (the old `credentialTypes` / `canSettle`) under-
 * describes the server. A client reads this list to know, per route, exactly
 * what to expect BEFORE it hits the 402.
 */
export interface RouteDescriptor {
  /** Request path. */
  readonly path: string
  /** Advertised credential types, in preference order (draft Table 2). */
  readonly credentialTypes: readonly string[]
  /** Challenge binding mode for this route (draft §6 / §8.0.1). */
  readonly challengeBinding: 'mppx-managed' | 'stored-lookup'
  /** Settlement fans out to a Permit2 split batch (permit2-only). */
  readonly hasSplits: boolean
  /** The route's handler is configured to sponsor on-chain settlement. */
  readonly canSettle: boolean
  /** Human-readable amount policy (fixed / dynamic + bounds). */
  readonly amountPolicy: string
}

export interface DeploymentConfig {
  readonly chain: string
  readonly chainId: number
  readonly token: string
  readonly currency: string
  readonly decimals: number
  /** Deployment default credential types (the base/article route's set). */
  readonly credentialTypes: readonly string[]
  readonly permit2Address: string
  readonly recipient: string
  /** Whether this deployment settles on-chain at all (any route has a signer). */
  readonly canSettle: boolean
  readonly explorerUrl: string
  /** Per-route breakdown — routes differ in types / binding / splits / settle. */
  readonly routes: readonly RouteDescriptor[]
}

export async function buildDeploymentConfig(config: ChargeServerConfig): Promise<DeploymentConfig> {
  // One extra preflight to describe the base (bsc-testnet/TEST_USDT) deployment. The
  // resolved values are read from the SDK's own resolution rather than a
  // hand-kept mirror; a production server would cache this once at boot.
  const resolved = await preflightCharge({
    chain: 'bsc-testnet',
    token: 'TEST_USDT',
    recipient: config.recipient,
    settlementAccount: config.settlementAccount,
    challengeBinding: { mode: 'mppx-managed' },
    ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
  })
  const r = resolved._resolved

  // `fullTypes` is the matrix-resolved set for the base (bsc-testnet/TEST_USDT) handler —
  // sourced from the SDK so it tracks eip3009Supported etc. The two narrowed
  // sets are NOT a matrix mirror: splits force EXACTLY ['permit2'] (SDK-enforced
  // in preflight), and hashOnly advertises the example's own explicit
  // `credentialTypes: ['transaction', 'hash']` from createHandlers — so echoing
  // them here re-states this server's config, not the curated matrix.
  const fullTypes = r.resolvedCredentialTypes
  const SPLIT_TYPES = ['permit2'] as const
  const HASH_ONLY_TYPES = ['transaction', 'hash'] as const

  const routes: readonly RouteDescriptor[] = [
    {
      path: '/api/article',
      credentialTypes: fullTypes,
      challengeBinding: 'mppx-managed',
      hasSplits: false,
      canSettle: true,
      amountPolicy: 'fixed 1 USDT',
    },
    {
      path: '/api/download',
      credentialTypes: fullTypes,
      challengeBinding: 'mppx-managed',
      hasSplits: false,
      canSettle: true,
      amountPolicy: 'fixed 1 USDT; binds ?order= as receipt externalId',
    },
    {
      path: '/api/tip',
      credentialTypes: fullTypes,
      challengeBinding: 'mppx-managed',
      hasSplits: false,
      canSettle: true,
      amountPolicy: 'dynamic ?amount=, server-bounded 0.10–100 USDT',
    },
    {
      path: '/api/split',
      credentialTypes: SPLIT_TYPES,
      challengeBinding: 'mppx-managed',
      hasSplits: true,
      canSettle: true,
      amountPolicy: 'fixed 1 USDT → 0.8 merchant + 0.2 fee (Permit2 batch)',
    },
    {
      path: '/api/hash-only',
      credentialTypes: HASH_ONLY_TYPES,
      challengeBinding: 'mppx-managed',
      hasSplits: false,
      canSettle: false,
      amountPolicy: 'fixed 1 USDT',
    },
    {
      path: '/api/stored/article',
      credentialTypes: fullTypes,
      challengeBinding: 'stored-lookup',
      hasSplits: false,
      canSettle: true,
      amountPolicy: 'fixed 1 USDT',
    },
  ]

  return {
    chain: 'bsc-testnet',
    chainId: r.chainId,
    token: 'TEST_USDT',
    currency: r.currency,
    decimals: r.decimals,
    credentialTypes: fullTypes,
    permit2Address: r.permit2Address,
    recipient: config.recipient,
    canSettle: true,
    explorerUrl: 'https://testnet.bscscan.com',
    routes,
  }
}
