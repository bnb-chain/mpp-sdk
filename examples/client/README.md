# B402 buyer example

This React wallet demonstrates the two MPP-native `b402/charge` paths:

- EIP-3009: sign `transferWithAuthorization`; no approval transaction.
- Permit2 Exact: approve canonical Permit2 when allowance is insufficient,
  then sign `PermitWitnessTransferFrom`.

## Run

Start `examples/server`, then:

```bash
pnpm --filter @bnb-chain/mpp-example-client dev
```

The default proxy targets `http://127.0.0.1:3001`. Optional overrides:

```env
VITE_B402_SERVER_URL=http://127.0.0.1:3001
VITE_B402_EIP3009_ENDPOINT=/api/b402/eip3009
VITE_B402_PERMIT2_ENDPOINT=/api/b402/permit2
```

Both tabs use the same four steps:

1. Fetch the signed MPP Challenge.
2. Apply buyer policy and sign the Challenge-bound credential.
3. Recover the payer and verify the Challenge-derived nonce locally.
4. Retry with `Authorization: Payment …` and decode `Payment-Receipt`.

The SDK never submits an ERC-20 approval. The Permit2 tab does so visibly as
application-owned wallet policy before calling the SDK signer.

[`src/actions/b402.tsx`](src/actions/b402.tsx) contains the buyer integration.
