# Autonoma

Self-executing agent. Static frontend + long-running agent server.

## Structure

```
apps/
  web/       React + Vite + TypeScript + Tailwind v4 + shadcn/ui (static, deploys to Cloudflare Pages)
  server/    Hono on Node (@hono/node-server), long-running service (deploys to Railway)
packages/
  shared/    @autonoma/shared — types shared between web and server (e.g. AgentEvent).
             Type-only, no build step; import type erases it at compile time.
  ui/        @autonoma/ui — shared shadcn/ui components (Button, Textarea, theme CSS),
             for reuse if more apps get added to this monorepo later. Follows shadcn's
             official monorepo pattern: components live here, apps import via
             "@autonoma/ui/components/*"; `pnpm dlx shadcn@latest add <x>` from an app
             writes new components into this package (see apps/web/components.json).
```

Managed as a pnpm workspace + Turborepo.

## Local development

```bash
pnpm install
cp apps/web/.env.example apps/web/.env
cp apps/server/.env.example apps/server/.env
pnpm dev   # runs both apps/web (5173) and apps/server (8787) via turbo
```

## Deployment

### Frontend — Cloudflare Pages

1. Connect this repo in the Cloudflare dashboard.
2. Build settings:
   - Root directory: `apps/web`
   - Build command: `pnpm install --frozen-lockfile && pnpm build`
   - Output directory: `dist`
3. Set env var `VITE_API_URL` to the deployed server URL.

Manual/CLI alternative: `cd apps/web && pnpm build && npx wrangler pages deploy`.

### Backend — Railway

1. Create a new Railway service from this repo.
2. Railway picks up `railway.json` at the repo root, which builds
   `apps/server/Dockerfile` (a multi-stage build using `turbo prune` so
   only the server's dependencies are installed).
3. Set env vars: `DATABASE_URL`, `OPENROUTER_API_KEY`, `E2B_API_KEY`,
   `TAVILY_API_KEY`, `CORS_ORIGIN` (the deployed frontend origin). Railway
   sets `PORT` automatically.

### Database — Neon

Create a Postgres project at Neon, copy the connection string into
`DATABASE_URL` for the server.

### Sandbox — e2b

Create an e2b API key, set it as `E2B_API_KEY` on the server.

### LLM — OpenRouter

The agent loop calls the LLM through [OpenRouter](https://openrouter.ai) (the
`openai` SDK pointed at OpenRouter's base URL), not the Anthropic API
directly. Set `OPENROUTER_API_KEY`. The model is `OPENROUTER_MODEL`
(default `deepseek/deepseek-v4-pro` — see `apps/server/src/agent/loop.ts`);
if a model gets rate-limited or restricted on your OpenRouter account, swap
it via the env var without touching code.

### Web search — Tavily

The agent's `web_search` tool calls [Tavily](https://tavily.com) (free tier
available) so it can ground plans/recommendations in real facts instead of
inventing them. Set `TAVILY_API_KEY`; without it the tool returns a clear
"not configured" error instead of failing silently.

## Notes

- Rate-limit or cap agent runs before sharing a live demo link — it burns LLM tokens per open.
- Turborepo caches builds per-package: touching only `apps/web` skips rebuilding `apps/server`, and vice versa.
