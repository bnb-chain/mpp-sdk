import type { FacilitatorClient } from '@x402/core/server'
import type { SchemeNetworkClient, SchemeNetworkServer } from '@x402/core/types'
import { test } from 'vitest'

import { B402ExactClientScheme } from './client/Scheme.js'
import { B402FacilitatorClient } from './server/Facilitator.js'
import { B402ExactServerScheme } from './server/Scheme.js'

test('official x402 Interfaces remain structurally satisfied', () => {
  const facilitator = null as unknown as B402FacilitatorClient
  const facilitatorInterface: FacilitatorClient = facilitator
  const clientInterface: SchemeNetworkClient = null as unknown as B402ExactClientScheme
  const serverInterface: SchemeNetworkServer = null as unknown as B402ExactServerScheme
  void facilitatorInterface
  void clientInterface
  void serverInterface
})
