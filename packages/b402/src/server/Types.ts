import type { SettleResult, SupportedResponse, VerifyResult } from '../Types.js'
import type { FacilitatorRequest } from './Client.js'

/** Raw B402 provider transport used by protocol Adapters; `B402Client` implements it. */
export interface B402Transport {
  settle(request: FacilitatorRequest): Promise<SettleResult>
  supported(): Promise<SupportedResponse>
  verify(request: FacilitatorRequest): Promise<VerifyResult>
}
