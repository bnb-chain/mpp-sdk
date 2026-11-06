# B402 browser demo. Build context must be the repository root:
# docker build -f examples/client/Dockerfile -t mpp-b402-client .
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY . .
# Preserve the workspace build approvals; optional native addons are already
# explicitly denied in pnpm-workspace.yaml and use their JavaScript fallbacks.
RUN pnpm install --frozen-lockfile

ARG VITE_BSC_TESTNET_RPC_URL
ARG VITE_BSC_RPC_URL
ENV VITE_BSC_TESTNET_RPC_URL=$VITE_BSC_TESTNET_RPC_URL
ENV VITE_BSC_RPC_URL=$VITE_BSC_RPC_URL

RUN pnpm --filter @bnb-chain/mpp-example-client build

FROM nginx:alpine AS runtime
COPY examples/client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/examples/client/dist /usr/share/nginx/html
EXPOSE 80
