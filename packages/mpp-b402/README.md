# `@bnb-chain/mpp-b402`

MPP custom payment method Adapter for Binance OnchainPay B402. The Provider
implementation lives in `@bnb-chain/b402`; this package only owns the
`b402/charge` MPP Method and its client/server Adapters.

```bash
pnpm add @bnb-chain/b402 @bnb-chain/mpp-b402 mppx viem
```

Merchant:

```ts
import { B402Client } from '@bnb-chain/b402/server'
import { b402 } from '@bnb-chain/mpp-b402/server'

const method = await b402.charge({
  client: B402Client.fromEnv()!,
  network: 'eip155:56',
  currency: {
    address: '0xToken',
    decimals: 18,
    name: 'Token EIP-712 Domain Name',
    version: '1',
  },
  recipient: '0xYourRegisteredPayout',
  onSettlementUnknown: queueForReconciliation,
})
```

Buyer:

```ts
import { CURATED_B402_SPENDERS } from '@bnb-chain/b402'
import { b402 } from '@bnb-chain/mpp-b402/client'

const method = b402.charge({
  account: walletAccount,
  permit2Allowance: readPermit2Allowance,
  trustedSpenders: {
    'eip155:56': [CURATED_B402_SPENDERS['eip155:56']!.exact],
  },
})
```

Both EIP-3009 and Permit2 Exact are supported. The signed nonce is bound to the
MPP Challenge. Permit2 Upto is intentionally unsupported. See the repository's
[`docs/b402.md`](../../docs/b402.md) for complete `Mppx.create()` examples and
settlement handling.
