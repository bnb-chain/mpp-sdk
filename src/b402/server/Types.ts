import type { FacilitatorRequest } from '../Client.js'
import type { SettleResult, SupportedResponse, VerifyResult } from '../Types.js'

/** Minimal B402 dependency used by the server integrations; `B402Client` implements it. */
export interface B402FacilitatorClient {
  settle(request: FacilitatorRequest): Promise<SettleResult>
  supported(): Promise<SupportedResponse>
  verify(request: FacilitatorRequest): Promise<VerifyResult>
}
