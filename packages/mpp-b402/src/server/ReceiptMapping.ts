import { Receipt } from 'mppx'

import type { B402ChargeTransferMethod } from '../Methods.js'

export function toMppReceipt(parameters: {
  challengeId: string
  externalId?: string | undefined
  network: string
  payer: `0x${string}`
  transaction: string
  transferMethod: B402ChargeTransferMethod
}): Receipt.Receipt {
  return Receipt.from({
    challengeId: parameters.challengeId,
    ...(parameters.externalId !== undefined ? { externalId: parameters.externalId } : {}),
    method: 'b402',
    network: parameters.network,
    payer: parameters.payer,
    reference: parameters.transaction,
    status: 'success',
    timestamp: new Date().toISOString(),
    transferMethod: parameters.transferMethod,
  })
}
