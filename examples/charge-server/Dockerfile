# charge-server — Hono HTTP server (draft-evm-charge-00).
#
# IMPORTANT: build context MUST be the repo ROOT, not this directory — the
# example depends on the workspace package @bnb-chain/mpp, which the root
# `zile` build produces. From the repo root:
#
#   docker build -f examples/charge-server/Dockerfile -t charge-server .
#
# Runtime env (set in Dokploy → Environment, NOT baked in):
#   RECIPIENT_ADDRESS, MPP_SECRET_KEY, SETTLEMENT_PRIVATE_KEY, RPC_URL
#   (RPC_URL is REQUIRED — viem's bundled public provider is unreachable in a
#   container and the Permit2 preflight probe will hang without it.)
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

# charge-server runs its TypeScript sources directly via tsx — identical to the
# `start` script, minus the prestart rebuild (the SDK is already built above).
WORKDIR /app/examples/charge-server
# Do NOT set NODE_ENV=production: the SDK then REQUIRES a durable atomic store
# (spec §9), but this example uses an in-process Store.memory() — fine for a
# single-instance demo (replay state is lost on restart), rejected under
# production. Leaving NODE_ENV unset → memory store with a one-time warning.
# For a real durable deployment, wire examples/charge-server/src/redisStore.ts
# to a Redis service and THEN set NODE_ENV=production.
ENV PORT=3000
EXPOSE 3000
CMD ["node", "--import", "tsx", "--no-warnings", "src/index.ts"]
