# B402 browser demo. Build context must be the repository root:
# docker build -f examples/client/Dockerfile -t mpp-b402-client .
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY . .
# Optional native addons have pure-JS fallbacks in this browser build.
RUN sed -i 's/^strictDepBuilds: true/strictDepBuilds: false/' pnpm-workspace.yaml
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
