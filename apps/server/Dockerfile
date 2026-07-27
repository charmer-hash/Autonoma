# Build context is the monorepo root (see railway.json).
FROM node:22-slim AS base
RUN corepack enable

FROM base AS pruner
WORKDIR /app
RUN npm install -g turbo
COPY . .
RUN turbo prune server --docker

FROM base AS installer
WORKDIR /app
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app
COPY --from=installer /app/ .
COPY --from=pruner /app/out/full/ .
RUN pnpm turbo run build --filter=server

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app .
WORKDIR /app/apps/server
EXPOSE 8787
CMD ["node", "--env-file-if-exists=.env", "dist/index.js"]
