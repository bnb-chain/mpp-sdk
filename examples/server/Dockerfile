# Minimal B402 merchant demo (Hono + mppx).
#
# IMPORTANT: build context MUST be the repo ROOT, not this directory — the
# example depends on the workspace package @bnb-chain/mpp, which the root
# `zile` build produces. From the repo root:
#
#   docker build -f examples/server/Dockerfile -t mpp-server .
#
# Runtime env is documented in .env.example. B402 credentials and payment
# configuration are required; secrets must be injected by the deploy platform.
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
ENV PORT=3001
EXPOSE 3001
CMD ["node", "--import", "tsx", "--no-warnings", "src/server.ts"]
