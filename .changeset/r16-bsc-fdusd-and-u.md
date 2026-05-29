---
'@bnb-chain/mpp': minor
---

Add `bsc/FDUSD` (First Digital USD) and `bsc/U` ("$U" / United Stables)
to the curated token matrix. Both are EIP-3009 capable on mainnet —
domains derived by brute-forcing the on-chain `DOMAIN_SEPARATOR()`
return value against EIP-712 candidates (2026-05-28 probes):

- `bsc/FDUSD` — `0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409`, 18 decimals,
  EIP-712 domain `First Digital USD` / `1`.
- `bsc/U` — `0xcE24439F2D9C6a2289F741120FE202248B666666`, 18 decimals,
  EIP-712 domain `United Stables` / `1`. Symbol on-chain is `U`; the
  product ships as "$U".

Both expose the full credential type set: `authorization`, `permit2`,
`transaction`, `hash`. `'U'` is added to `SupportedTokenPreset`.

Note: the BSC testnet $U sibling at `0x2Ae938053c112Bd81042043945d142e208b50a66`
does NOT implement EIP-3009 (different deployment); `('bsc-testnet', 'U')`
is intentionally absent from the matrix and locked by a regression test.
