# client-demo — pay a 402 from Node

**Audience: API consumers** — AI agents, scripts, backends. This CLI runs
the full buyer loop against any MPP endpoint:

```
GET url                     → 402 + WWW-Authenticate: Payment <challenge>
parse challenge             → amount / token / chain / accepted types
build one credential        → @bnb-chain/mpp/client
GET url + Authorization     → 200 + content + Payment-Receipt header
```

There is no wallet UI and no browser — a private key in `.env` signs
everything, which is exactly how a machine payer integrates.

## Run it

```bash
cp .env.example .env      # set PAYER_PRIVATE_KEY (funded testnet key)

# pay the merchant-demo endpoint (default url)
pnpm --filter @bnb-chain/mpp-example-client-demo start

# pay any other MPP endpoint / force a credential type
pnpm --filter @bnb-chain/mpp-example-client-demo start http://localhost:3003/acme-research/premium-report
pnpm --filter @bnb-chain/mpp-example-client-demo start http://localhost:3001/api/premium permit2
```

The payer account needs **tBNB** (gas) and **test USDT** on BSC Testnet —
faucet links in [.env.example](.env.example).

## Credential types, from the payer's seat

The server's challenge advertises `credentialTypes` in preference order;
the CLI picks the first it can build (override with the second CLI arg):

| type            | you sign                                            | gas you pay                                  | server needs a signer |
| --------------- | --------------------------------------------------- | -------------------------------------------- | --------------------- |
| `permit2`       | EIP-712 typed data                                  | one-time `approve(Permit2, max)` (auto-sent) | yes                   |
| `transaction`   | a full EIP-1559 transfer (server broadcasts it)     | the transfer itself                          | no                    |
| `hash`          | nothing — you broadcast, then reference the tx hash | the transfer itself                          | no                    |
| `authorization` | EIP-3009 typed data (token must support it)         | none                                         | yes                   |

Note for `authorization`: the token's EIP-712 domain (`name`/`version`)
is a property of the token contract and is **not** on the wire — the CLI
ships the SDK's probed anchors (Sepolia/Ethereum/Base USDC, BSC
FDUSD/$U) in `EIP3009_DOMAINS`.

## What "paid" looks like

```
✔ HTTP 200 — content unlocked:
{ "title": "BNB Chain stablecoin market snapshot", ... }

✔ Payment-Receipt (draft §7.6):
  status:      success
  reference:   0x6f3a… (settlement / transfer tx)
  challengeId: pc_…
  chainId:     97
  explorer:    https://testnet.bscscan.com/tx/0x6f3a…
```

`reference` is the on-chain tx — the merchant's proof, your audit trail.

## Pointing it at real deployments

The CLI hard-codes nothing about the server: chain, token, amount,
recipient, Permit2 address, and accepted types all come off the
challenge. Anything that speaks `draft-evm-charge-00` works — the
[merchant-demo](../merchant-demo), the [facilitator-demo](../facilitator-demo)
gateway, or the full [charge-server](../charge-server).
