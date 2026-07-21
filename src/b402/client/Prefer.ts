import type { B402ChargeRequest, B402ChargeTransferMethod } from '../Methods.js'

export type B402ChallengeCandidate = {
  readonly challenge: {
    readonly intent: string
    readonly method: string
    readonly request: Record<string, unknown>
  }
  readonly index?: number | undefined
  readonly method: unknown
}

export type B402ChallengeOrder = <candidate extends B402ChallengeCandidate>(
  candidates: readonly candidate[],
) => readonly candidate[] | Promise<readonly candidate[]>

export type B402MissingAllowanceBehavior = 'fallback' | 'require-approval'

export function preferB402Challenges(options: {
  canUsePermit2?: ((request: B402ChargeRequest) => boolean | Promise<boolean>) | undefined
  methods: readonly B402ChargeTransferMethod[]
  onMissingAllowance?: B402MissingAllowanceBehavior | undefined
}): B402ChallengeOrder {
  const rank = new Map(options.methods.map((method, index) => [method, index]))
  const missingAllowance = options.onMissingAllowance ?? 'require-approval'

  return async (candidates) => {
    const b402 = await Promise.all(
      candidates
        .filter((candidate) => isB402Charge(candidate))
        .map(async (candidate, stableIndex) => {
          const request = candidate.challenge.request as B402ChargeRequest
          const transferMethod = request.methodDetails.assetTransferMethod
          let unavailable = false
          if (
            transferMethod === 'permit2-exact' &&
            missingAllowance === 'fallback' &&
            options.canUsePermit2
          ) {
            unavailable = !(await options.canUsePermit2(request))
          }
          return {
            candidate,
            rank: (unavailable ? options.methods.length : 0) + (rank.get(transferMethod) ?? 999),
            stableIndex,
          }
        }),
    )
    b402.sort((left, right) => left.rank - right.rank || left.stableIndex - right.stableIndex)

    let index = 0
    return candidates.map((candidate) =>
      isB402Charge(candidate) ? (b402[index++]?.candidate ?? candidate) : candidate,
    )
  }
}

function isB402Charge(candidate: B402ChallengeCandidate): boolean {
  return candidate.challenge.method === 'b402' && candidate.challenge.intent === 'charge'
}
