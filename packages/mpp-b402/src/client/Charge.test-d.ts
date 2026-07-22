import { Mppx } from 'mppx/client'
import { privateKeyToAccount } from 'viem/accounts'
import { test } from 'vitest'

import { charge } from './Charge.js'

test('b402 client composes directly with Mppx.create and orderChallenges', () => {
  const method = charge({
    account: privateKeyToAccount(
      '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    ),
    permit2Allowance: () => Promise.resolve(0n),
    trustedSpenders: {
      'eip155:56': ['0x1111111111111111111111111111111111111111'],
    },
  })

  Mppx.create({
    methods: [method],
    orderChallenges: method.prefer(['permit2-exact', 'eip3009'], {
      onMissingAllowance: 'fallback',
    }),
    polyfill: false,
  })
})
