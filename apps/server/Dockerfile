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

# node:22-slim 镜像自带 uid 1000 的 node 用户——不加 USER 的话容器里的
# 进程默认以 root 运行，一旦进程被攻破（依赖 RCE 之类），攻击者在容器里
# 就是 root。--chown 是必须的：COPY 默认按 root 落地文件，不重新赋权限
# 的话切到 node 用户后连自己的产物都读不了。
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder --chown=node:node /app .
WORKDIR /app/apps/server
USER node
EXPOSE 8787
CMD ["node", "--env-file-if-exists=.env", "dist/index.js"]
