# server — the merchant side of the demo pair (Hono, draft-evm-charge-00 +
# optional b402/x402).
#
# IMPORTANT: build context MUST be the repo ROOT, not this directory — the
# example depends on the workspace package @bnb-chain/mpp, which the root
# `zile` build produces. From the repo root:
#
#   docker build -f examples/server/Dockerfile -t mpp-server .
#
# Runtime env (set in your deploy platform, NOT baked in) — see .env.example
# for the full commented matrix:
#   RECIPIENT_ADDRESS, MPP_SECRET_KEY          required (mode 1 works with just these)
#   RPC_URL                                     recommended — the bundled public
#                                               endpoint rate-limits in containers
#   SETTLEMENT_PRIVATE_KEY                      optional → mode 2 (local permit2 settle)
#   B402_BASE_URL/_CLIENT_ID/_ACCESS_TOKEN/_PRIVATE_KEY
#                                               optional → mode 3 (b402 EIP-3009 settle)
#   B402_CHAIN, B402_RPC_URL, PRICE_DECIMAL     mode-3 tuning ('bsc' = ⚠️ REAL funds)
#   X402_TOKEN_ADDRESS, X402_TOKEN_NAME         optional → adds the /x402/premium
#                                               permit2-exact route (needs mode 3)
FROM node:22-slim

# corepack ships the pnpm pinned in package.json's "packageManager" field.
RUN corepack enable
WORKDIR /app

# Install the whole workspace from the lockfile, then build the SDK (dist/).
COPY . .
# node:22-slim ships no C toolchain, so the optional native addons
# (keccak / bufferutil / utf-8-validate) can't compile here — and the
# workspace's strictDepBuilds:true turns pnpm's "ignored build scripts" notice
# into a hard error. All three have pure-JS fallbacks the server doesn't need
# natively, so relax the gate for THIS IMAGE LAYER ONLY (the repo file on disk
# is untouched; the COPY'd copy inside the layer is what's edited).
RUN sed -i 's/^strictDepBuilds: true/strictDepBuilds: false/' pnpm-workspace.yaml
RUN pnpm install --frozen-lockfile
RUN pnpm build

# The server runs its TypeScript sources directly via tsx — identical to the
# `start` script, minus the prestart rebuild (the SDK is already built above).
WORKDIR /app/examples/server
# Do NOT set NODE_ENV=production: the SDK then REQUIRES a durable atomic store
# (spec §9), but this example uses an in-process Store.memory() — fine for a
# single-instance demo (replay state is lost on restart), rejected under
# production. Leaving NODE_ENV unset → memory store with a one-time warning.
# For a real durable deployment, wire a Redis-backed store (docs/replay-store.md)
# and THEN set NODE_ENV=production.
ENV PORT=3001
EXPOSE 3001
CMD ["node", "--import", "tsx", "--no-warnings", "src/server.ts"]
