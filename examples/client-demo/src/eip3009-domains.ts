/**
 * EIP-712 domains for EIP-3009 (`authorization`) tokens, keyed
 * `${chainId}:${currency.toLowerCase()}`.
 *
 * The domain (`name` / `version`) is a property of the token CONTRACT and is
 * NOT carried on the wire, so a real client configures it per token. This is the
 * SDK's set of probed anchors — shared by both the low-level (`pay.ts`) and the
 * high-level (`pay-policy.ts`) demos so their `authorization` coverage matches.
 */
export const EIP3009_DOMAINS: Record<string, { name: string; version: string }> = {
  '11155111:0x1c7d4b196cb0c7b01d743fbc6116a902379c7238': { name: 'USDC', version: '2' },
  '1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { name: 'USD Coin', version: '2' },
  '8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { name: 'USD Coin', version: '2' },
  '56:0xc5f0f7b66764f6ec8c8dff7ba683102295e16409': { name: 'First Digital USD', version: '1' },
  '56:0xce24439f2d9c6a2289f741120fe202248b666666': { name: 'United Stables', version: '1' },
  // BSC Testnet $U — the b402 testnet settlement token (merchant-demo mode 3).
  // version '1' assumed (parity with mainnet $U; facilitator-gated, can't read
  // on-chain) — see src/server/curated.ts.
  '97:0x180bc1a9843a65d4116e44886fd3558515a56a49': { name: 'United Stables', version: '1' },
}
