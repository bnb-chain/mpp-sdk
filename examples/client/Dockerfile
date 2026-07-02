# client — Vite/React SPA, served by nginx with same-origin /api + /x402
# proxies to the server container.
#
# IMPORTANT: build context MUST be the repo ROOT (monorepo — see below). From
# the repo root:
#
#   docker build -f examples/client/Dockerfile -t mpp-client .
#
# The demo calls the server via RELATIVE paths (/api/premium, /x402/premium),
# so in production nginx reverse-proxies both prefixes to the server container
# on the shared Compose network — same origin, no CORS, demo code unchanged.
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY . .
# See examples/server/Dockerfile: relax strictDepBuilds for this image layer so
# the toolchain-free slim base can skip the optional native addons (they have
# pure-JS fallbacks). The repo's pnpm-workspace.yaml on disk is untouched.
RUN sed -i 's/^strictDepBuilds: true/strictDepBuilds: false/' pnpm-workspace.yaml
RUN pnpm install --frozen-lockfile

# RPCs the in-browser wallet uses to READ the chains (wagmi). Baked at build
# time because Vite inlines import.meta.env.* into the static bundle. Optional
# — default to public endpoints when unset (fine at demo volume).
ARG VITE_BSC_TESTNET_RPC_URL
ARG VITE_BSC_RPC_URL
ENV VITE_BSC_TESTNET_RPC_URL=$VITE_BSC_TESTNET_RPC_URL
ENV VITE_BSC_RPC_URL=$VITE_BSC_RPC_URL

# The client's `build` script runs its prebuild hook (builds the SDK) then
# `vite build`, emitting examples/client/dist.
RUN pnpm --filter @bnb-chain/mpp-example-client build

FROM nginx:alpine AS runtime
COPY examples/client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/examples/client/dist /usr/share/nginx/html
EXPOSE 80
# nginx:alpine's default CMD already runs `nginx -g 'daemon off;'`.
