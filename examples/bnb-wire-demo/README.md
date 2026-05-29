# bnb-wire-demo

A read-only **wire-shape inspector** for the BNB Chain stablecoins in the
curated matrix. For each `(bsc, token)` it resolves the deployment via the SDK
(`preflightCharge`) and prints what a client would see on the wire:

- `currency` / `decimals` / `chainId`
- accepted `credentialTypes` (preference order)
- the EIP-712 (EIP-3009) domain where the token supports it
- the challenge `request` shape
- the receipt field shape (draft §7.6)

Tokens covered: `FDUSD`, `U` (both EIP-3009), `BINANCE_PEG_USDC`,
`BINANCE_PEG_DAI` (bridged BEP-20, no EIP-3009).

**Nothing is signed or broadcast.** preflight does a single read-only
`eth_getCode` Permit2 probe against the RPC; that's the only network call.

```bash
pnpm --filter @bnb-chain/mpp-example-bnb-wire-demo start
# or point at your own BSC node:
BSC_RPC_URL=https://your-node pnpm --filter @bnb-chain/mpp-example-bnb-wire-demo start
```

opBNB tokens are intentionally absent — their stablecoin provenance is not yet
verified into the curated matrix (`src/server/curated.ts`); they should be
cross-checked against the BNB Chain bridge/token list + opBNBScan before
landing.
