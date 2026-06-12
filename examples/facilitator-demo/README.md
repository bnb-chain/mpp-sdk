# facilitator-demo — onboard merchants without touching their code

**Audience: facilitators / payment operators.** You run payments for
many merchants. This demo shows the MPP onboarding model where the
merchant's existing API **does not change at all** — you put a paid
gateway in front of it and route their traffic through your facilitator
endpoint.

```
payer ──► facilitator gateway :3003 ──► merchant upstream :3002
            (this is YOUR service)        (merchant's API, unmodified)

  GET /acme-research/premium-report   no credential → 402 + challenge
                                      valid credential → verify+settle →
                                      forward upstream → 200 + Payment-Receipt
  GET /acme-research/health           free passthrough
  GET /openapi.json · /llms.txt       auto-generated discovery for agents
```

Two processes:

- [`src/upstream.ts`](src/upstream.ts) — the merchant's current API.
  **Zero payment code** (no `@bnb-chain/mpp`, no keys, no 402s).
- [`src/facilitator.ts`](src/facilitator.ts) — your gateway:
  [`mppx/proxy`](https://github.com/wevm/mppx)'s `Proxy.create` with this
  SDK's `chargeAsync` method mounted per paid route.

## The trust split

|                                 | merchant                                 | facilitator (you)        |
| ------------------------------- | ---------------------------------------- | ------------------------ |
| API code changes                | **none**                                 | —                        |
| receives funds                  | **directly on-chain** at its own address | never custodies          |
| HMAC challenge secret           | —                                        | owns                     |
| replay store / RPC ops          | —                                        | owns                     |
| settlement signer (permit2 gas) | —                                        | optional, your value-add |

The merchant's onboarding checklist is literally: (1) give you a payout
address, (2) point clients / DNS at your gateway URL.

## Run it

```bash
cp .env.example .env   # MERCHANT_RECIPIENT_ADDRESS + MPP_SECRET_KEY

# terminal 1 — the merchant's untouched API
pnpm --filter @bnb-chain/mpp-example-facilitator-demo start:upstream

# terminal 2 — your gateway
pnpm --filter @bnb-chain/mpp-example-facilitator-demo start
```

Probe it:

```bash
curl -s http://localhost:3003/acme-research/health          # free → 200
curl -i http://localhost:3003/acme-research/premium-report  # paid → 402 + challenge
curl -s http://localhost:3003/llms.txt                      # agent discovery
```

Pay it with [`examples/client-demo`](../client-demo) (the client needs no
facilitator-specific code — it's a normal MPP endpoint):

```bash
pnpm --filter @bnb-chain/mpp-example-client-demo start \
  http://localhost:3003/acme-research/premium-report
```

## Onboarding merchant #2, #3, …

Each merchant is one more `custom(...)` service entry — its own upstream
`baseUrl`, its own payout `recipient`, its own per-route prices. The
charge method is per-merchant because `recipient` is config-time:

```ts
const acme = Mppx.create({
  methods: [await chargeAsync({ ...pair, recipient: ACME_PAYOUT })],
  secretKey,
})
const globex = Mppx.create({
  methods: [await chargeAsync({ ...pair, recipient: GLOBEX_PAYOUT })],
  secretKey,
})

Proxy.create({
  services: [
    custom('acme-research', {
      baseUrl: 'https://api.acme-research.example',
      routes: { 'GET /premium-report': acme.evm.charge({ amount: PRICE }) },
    }),
    custom('globex-quotes', {
      baseUrl: 'https://quotes.globex.example',
      routes: {
        'GET /spot/:pair': globex.evm.charge({ amount: QUOTE_PRICE }),
        'GET /docs': true,
      },
    }),
  ],
})
```

## Production notes for facilitators

- **Replay store**: one durable atomic store (Redis/Postgres) shared by
  all gateway pods — this is what makes "a credential settles at most
  once" true across your fleet. See
  [`docs/replay-store.md`](../../docs/replay-store.md).
- **Settlement signer**: a funded hot wallet per deployment; meter its
  gas spend per merchant (see the `GasGuard` pattern in
  [`examples/charge-server/src/hardening.ts`](../charge-server/src/hardening.ts)).
- **Upstream trust**: the gateway strips payment headers before
  forwarding; the upstream should only accept traffic from the gateway
  (network policy / mTLS / shared header).
- **Fees**: configure `splits` on the charge method to take a facilitator
  fee per settlement (Permit2 batch: merchant + fee recipient — see
  `/api/split` in [`examples/charge-server`](../charge-server)).
