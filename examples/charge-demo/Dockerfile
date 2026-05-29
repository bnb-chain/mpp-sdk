# charge-demo — Vite/React SPA, served by nginx with a same-origin /api proxy.
#
# IMPORTANT: build context MUST be the repo ROOT (monorepo — see below). From
# the repo root:
#
#   docker build -f examples/charge-demo/Dockerfile -t charge-demo .
#
# The demo calls the server via RELATIVE paths (/api/article, /api/config), so
# in production nginx reverse-proxies /api/* to the charge-server container on
# the shared Compose network — same origin, no CORS, demo code unchanged.
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY . .
# See charge-server/Dockerfile: relax strictDepBuilds for this image layer so
# the toolchain-free slim base can skip the optional native addons (they have
# pure-JS fallbacks). The repo's pnpm-workspace.yaml on disk is untouched.
RUN sed -i 's/^strictDepBuilds: true/strictDepBuilds: false/' pnpm-workspace.yaml
RUN pnpm install --frozen-lockfile

# RPC the demo's wallet uses to READ Sepolia (wagmi). Baked at build time
# because Vite inlines import.meta.env.* into the static bundle. Optional —
# defaults to a public node if unset.
ARG VITE_SEPOLIA_RPC_URL
ENV VITE_SEPOLIA_RPC_URL=$VITE_SEPOLIA_RPC_URL

# The demo's `build` script runs its prebuild hook (builds the SDK) then
# `vite build`, emitting examples/charge-demo/dist.
RUN pnpm --filter @bnb-chain/mpp-example-charge-demo build

FROM nginx:alpine AS runtime
COPY examples/charge-demo/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/examples/charge-demo/dist /usr/share/nginx/html
EXPOSE 80
# nginx:alpine's default CMD already runs `nginx -g 'daemon off;'`.
