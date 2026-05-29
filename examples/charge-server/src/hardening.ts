/**
 * Production-hardening skeletons for the charge-server (draft §10.6 fee-payer
 * risks). These are ILLUSTRATIVE, in-memory, single-instance examples — a real
 * deployment uses a shared store (Redis) for rate limits + budgets and tracks
 * actual settlement gas. They show the SHAPE of the switches a fee-paying
 * server should have:
 *
 *   - rateLimit       per-IP request throttle (cheap DoS / griefing guard)
 *   - GasGuard        watch the settlement signer's balance + an hourly gas
 *                     budget, so the server stops sponsoring when low
 *   - pickHandlerForGas  dynamic credential gating WITHOUT any SDK change:
 *                     serve the full (server-sponsored) handler when gas is
 *                     healthy, else fall back to the payer-funded handler
 *                     (transaction / hash only) so a low/empty signer can't be
 *                     griefed into failed sponsored settlements.
 */

import type { Context, Next } from 'hono'
import type { Address, PublicClient } from 'viem'

/* -------------------------------------------------------------------------- */
/*  Per-IP rate limiter (fixed window, in-memory)                             */
/* -------------------------------------------------------------------------- */

export function rateLimit(opts: {
  windowMs: number
  max: number
  /** Defaults to the X-Forwarded-For header (falls back to a constant). */
  keyOf?: (c: Context) => string
}): (c: Context, next: Next) => Promise<Response | void> {
  const hits = new Map<string, { count: number; resetAt: number }>()
  const keyOf = opts.keyOf ?? ((c) => c.req.header('x-forwarded-for') ?? 'local')
  return async (c, next) => {
    const key = keyOf(c)
    const now = Date.now()
    const cur = hits.get(key)
    if (!cur || now > cur.resetAt) {
      hits.set(key, { count: 1, resetAt: now + opts.windowMs })
    } else {
      cur.count += 1
      if (cur.count > opts.max) {
        return c.json({ error: 'rate limit exceeded — slow down' }, 429)
      }
    }
    await next()
  }
}

/* -------------------------------------------------------------------------- */
/*  Settlement-signer gas guard                                               */
/* -------------------------------------------------------------------------- */

export interface GasSnapshot {
  readonly balanceWei: bigint
  readonly budgetRemainingWei: bigint
  /** Healthy enough to sponsor a server-side settlement right now. */
  readonly canSponsor: boolean
}

export class GasGuard {
  private spentThisHourWei = 0n
  private hourResetAt = Date.now() + 3_600_000

  constructor(
    private readonly publicClient: PublicClient,
    private readonly signer: Address,
    private readonly opts: { minBalanceWei: bigint; hourlyBudgetWei: bigint },
  ) {}

  private rollHour(): void {
    if (Date.now() > this.hourResetAt) {
      this.spentThisHourWei = 0n
      this.hourResetAt = Date.now() + 3_600_000
    }
  }

  /** Record gas actually spent on a settlement (gasUsed * effectiveGasPrice). */
  recordSpend(wei: bigint): void {
    this.rollHour()
    this.spentThisHourWei += wei
  }

  async snapshot(): Promise<GasSnapshot> {
    this.rollHour()
    const budgetRemainingWei = this.opts.hourlyBudgetWei - this.spentThisHourWei
    let balanceWei: bigint
    try {
      balanceWei = await this.publicClient.getBalance({ address: this.signer })
    } catch {
      // Fail CLOSED: if the balance read fails, assume we CANNOT sponsor.
      // Better to degrade to payer-funded than sponsor blind (or 500 the
      // route) on a flaky RPC.
      return { balanceWei: 0n, budgetRemainingWei, canSponsor: false }
    }
    const canSponsor = balanceWei >= this.opts.minBalanceWei && budgetRemainingWei > 0n
    return { balanceWei, budgetRemainingWei, canSponsor }
  }
}

/**
 * Record the gas a server-sponsored settlement actually spent, from its tx
 * receipt — call from `onPaymentSuccess` on sponsored handlers (permit2 /
 * authorization) so the hourly budget tracks real spend. Best-effort: a missed
 * read just under-counts the budget (the balance floor still backstops).
 */
export async function recordSettlementGas(
  guard: GasGuard,
  publicClient: PublicClient,
  txHash: string,
): Promise<void> {
  try {
    const r = await publicClient.getTransactionReceipt({ hash: txHash as `0x${string}` })
    guard.recordSpend(r.gasUsed * r.effectiveGasPrice)
  } catch {
    // ignore — gas accounting is best-effort
  }
}

/* -------------------------------------------------------------------------- */
/*  Dynamic credential gating (no SDK change)                                 */
/* -------------------------------------------------------------------------- */

/**
 * Return `full` (server-sponsored: all credential types) when the signer can
 * still pay gas, else `fallback` (payer-funded: transaction / hash only). The
 * SDK resolves credentialTypes at factory-config time, so dynamic gating is
 * done HERE by choosing between two pre-built handlers — no per-request SDK
 * hook required.
 */
export async function pickHandlerForGas<T>(guard: GasGuard, full: T, fallback: T): Promise<T> {
  const { canSponsor } = await guard.snapshot()
  return canSponsor ? full : fallback
}
