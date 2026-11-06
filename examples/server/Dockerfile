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
# Preserve the workspace build approvals; optional native addons are already
# explicitly denied in pnpm-workspace.yaml and use their JavaScript fallbacks.
RUN pnpm install --frozen-lockfile
RUN pnpm build

# The server runs its TypeScript sources directly via tsx — identical to the
# `start` script, minus the prestart rebuild (the SDK is already built above).
WORKDIR /app/examples/server
ENV PORT=3001
EXPOSE 3001
CMD ["node", "--import", "tsx", "--no-warnings", "src/server.ts"]
