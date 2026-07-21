# B402 merchant example

This Hono server exposes only the two MPP-native `b402/charge` paths.

## Run

```bash
cp examples/server/.env.example examples/server/.env
pnpm --filter @bnb-chain/mpp-example-server start
```

| Route                   | MPP method    | B402 settlement |
| ----------------------- | ------------- | --------------- |
| `GET /api/b402/eip3009` | `b402/charge` | EIP-3009        |
| `GET /api/b402/permit2` | `b402/charge` | Permit2 Exact   |

All uncommented values in `.env.example` are required. Select a token/network
pair for which `/supported` advertises both `eip3009` and `permit2-exact`.
`B402_TOKEN_NAME` and `B402_TOKEN_VERSION` are the token's EIP-712 domain
values, not display metadata. Startup resolves `/supported` and fails early if
either requested capability is unavailable for the configured token/network.

`onSettlementUnknown` currently logs the recovery event. Production merchants
should route it to their existing order/reconciliation workflow.

[`src/server.ts`](src/server.ts) is the complete integration.
