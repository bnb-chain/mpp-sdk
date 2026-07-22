# `@bnb-chain/b402`

Binance OnchainPay B402 provider implementation for official x402 clients and
resource servers. It supports B402 EIP-3009 and Permit2 Exact. Permit2 Upto is
intentionally unsupported.

```bash
pnpm add @bnb-chain/b402 @x402/core @x402/fetch viem
```

Resource server:

```ts
import { x402ResourceServer } from '@x402/core/server'
import { B402Client, B402ExactServerScheme, B402FacilitatorClient } from '@bnb-chain/b402/server'

const transport = B402Client.fromEnv()
if (!transport) throw new Error('B402 is not configured')

const facilitator = new B402FacilitatorClient({
  client: transport,
  onSettlementUnknown: queueForReconciliation,
})

const payments = new x402ResourceServer(facilitator).register(
  'eip155:*',
  new B402ExactServerScheme({ facilitator }),
)
await payments.initialize()
```

Buyer:

```ts
import { x402Client } from '@x402/core/client'
import { B402ExactClientScheme } from '@bnb-chain/b402/client'

const payments = new x402Client().register(
  'eip155:*',
  new B402ExactClientScheme({
    account: walletAccount,
    permit2Allowance: readPermit2Allowance,
    trustedSpenders: {
      'eip155:56': ['0xAuditedB402ExactProxy'],
    },
  }),
)
```

Use this client with `@x402/fetch`, `@x402/axios`, or another official x402
transport Adapter. EIP-3009 needs no ERC-20 approval. Permit2 Exact requires a
one-time token approval to canonical Permit2 and an explicit trusted B402
spender list.

`B402SettlementUnknownError` means settlement may already be on-chain. Persist
the handler event and reconcile it before accepting another payment attempt.
See the repository's [`docs/b402.md`](../../docs/b402.md) for the full route and
security configuration.
