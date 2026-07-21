# B402 demo

The repository ships one merchant application and one browser buyer. The pair
is intentionally narrow: it demonstrates only the two MPP-native
`b402/charge` transfer methods.

## Merchant

| Route               | MPP method    | B402 settlement |
| ------------------- | ------------- | --------------- |
| `/api/b402/eip3009` | `b402/charge` | EIP-3009        |
| `/api/b402/permit2` | `b402/charge` | Permit2 Exact   |

Copy [`examples/server/.env.example`](../examples/server/.env.example) and
provide facilitator onboarding values plus one token/network pair advertised
by `/supported` for both methods.

```bash
pnpm --filter @bnb-chain/mpp-example-server start
```

Startup resolves both provider snapshots before accepting traffic. The example
also wires `onSettlementUnknown`; a production merchant should hand that event
to its existing order/reconciliation workflow.

## Browser buyer

```bash
pnpm --filter @bnb-chain/mpp-example-client dev
```

Choose either `B402 · EIP-3009` or `B402 · Permit2 Exact`, then run the shared
four-step flow:

1. fetch the signed MPP Challenge;
2. apply buyer policy and sign a Challenge-bound credential;
3. recover the payer and verify the Challenge nonce locally;
4. submit the credential through standard MPP `Authorization` and parse the
   `Payment-Receipt`.

EIP-3009 needs no approval transaction. Permit2 checks the ERC-20 allowance
and visibly requests `approve(canonicalPermit2, maxUint256)` only when needed;
this remains application-owned wallet policy, not hidden SDK behavior.

The complete integration points are
[`examples/server/src/server.ts`](../examples/server/src/server.ts) and
[`examples/client/src/actions/b402.tsx`](../examples/client/src/actions/b402.tsx).

For production-facing API snippets, provider trust boundaries, and the
standard EIP-3009 facilitator Adapter, see [b402.md](b402.md).
