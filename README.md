# Autonoma

自执行 Agent。静态前端 + 常驻运行的 Agent 服务端。

## 项目结构

```
apps/
  web/       React + Vite + TypeScript + Tailwind v4 + shadcn/ui（静态站点，部署到 Cloudflare Pages）
  server/    基于 Node 的 Hono（@hono/node-server），常驻服务（部署到 Railway）
packages/
  shared/    @autonoma/shared —— web 与 server 之间共享的类型（例如 AgentEvent）。
             只有类型定义，没有构建步骤；`import type` 会在编译期被完全擦除。
  ui/        @autonoma/ui —— 共享的 shadcn/ui 组件（Button、Textarea、主题 CSS），
             供以后这个 monorepo 里新增其他应用时复用。遵循 shadcn 官方的 monorepo
             模式：组件放在这里，各应用通过 "@autonoma/ui/components/*" 导入；在某个
             应用里执行 `pnpm dlx shadcn@latest add <x>` 会把新组件写进这个包
             （见 apps/web/components.json）。
```

以 pnpm workspace + Turborepo 的方式管理。

## 本地开发

```bash
pnpm install
cp apps/web/.env.example apps/web/.env
cp apps/server/.env.example apps/server/.env
# 在 apps/server/.env 里填好 DATABASE_URL —— 没有它服务端起不来
pnpm dev   # 通过 turbo 同时跑 apps/web（5173）和 apps/server（8787）
```

## 部署

### 前端 —— Cloudflare Pages

1. 在 Cloudflare 控制台里接入这个仓库。
2. 构建配置：
   - 根目录：`apps/web`
   - 构建命令：`pnpm install --frozen-lockfile && pnpm build`
   - 输出目录：`dist`
3. 设置环境变量 `VITE_API_URL` 为已部署的服务端地址。

也可以手动/用 CLI 部署：`cd apps/web && pnpm build && npx wrangler pages deploy`。

### 后端 —— Railway

1. 从这个仓库创建一个新的 Railway 服务。
2. Railway 会读取仓库根目录的 `railway.json`，用它来构建
   `apps/server/Dockerfile`（一个多阶段构建，用 `turbo prune` 只安装
   服务端需要的依赖）。
3. 设置环境变量：`DATABASE_URL`、`OPENROUTER_API_KEY`、`E2B_API_KEY`、
   `TAVILY_API_KEY`、`CORS_ORIGIN`（已部署前端的域名）、
   `AUTH_SESSION_SECRET`、`R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、
   `R2_SECRET_ACCESS_KEY`、`R2_BUCKET`。`PORT` 由 Railway 自动设置。

### 数据库 —— Neon

在 Neon 创建一个 Postgres 项目，把连接串复制到服务端的
`DATABASE_URL` 里。

### 沙箱 —— e2b

创建一个 e2b API key，设置为服务端的 `E2B_API_KEY`。

### 大模型 —— OpenRouter

Agent 循环是通过 [OpenRouter](https://openrouter.ai) 来调用大模型的
（用 `openai` SDK，把 base URL 指向 OpenRouter），而不是直接调用
Anthropic API。设置 `OPENROUTER_API_KEY`。模型由 `OPENROUTER_MODEL`
指定（默认 `deepseek/deepseek-v4-pro`，见 `apps/server/src/agent/client.ts`）；
如果某个模型在你的 OpenRouter 账号上被限流或限制了，改这个环境变量
就能换模型，不用改代码。

`OPENROUTER_MODEL` 的默认模型只支持文本 —— DeepSeek 在 OpenRouter 上
不支持图片输入。每当某一轮需要给 Agent 看图片时（刚上传的照片，或者
`view_image` 工具调用重新从沙箱里读取一张图片 —— 见下文），那一次
大模型调用会改走 `OPENROUTER_VISION_MODEL`（默认
`qwen/qwen3-vl-235b-a22b-instruct`）；其他轮次仍然用更便宜的纯文本模型。
默认没有选 Claude/GPT/Gemini 系列，是因为部分地区的 OpenRouter 账号调用
这几家的模型（哪怕是纯文本请求）会收到 403 的 "provider Terms Of
Service" 错误 —— 实测 `x-ai/grok-4.5`、`z-ai/glm-4.6v`、
`qwen/qwen3-vl-*` 系列不受影响；Qwen3-VL-235B 在同等图片识别效果下价格
最低。如果你的账号能正常访问 Claude/GPT/Gemini，也可以把
`OPENROUTER_VISION_MODEL` 改指向那个模型。

### 产物导出 —— Cloudflare R2

Agent 的 `export_artifact` 工具会把它在沙箱里生成的文件（图表、PDF、
Excel、CSV 等）上传到 R2 桶，因为沙箱本身在每次请求结束后就会被销毁。
在 Cloudflare 控制台创建一个 R2 桶和一个 API token（S3 兼容凭证），
然后设置 `R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、
`R2_BUCKET`。文件是通过一个短时效的预签名 URL
（`GET /api/artifacts/:id`）返回给用户的，从不经过服务端代理转发。

桶创建好之后，跑一次 `cd apps/server && pnpm configure-r2-lifecycle`，
给 `uploads/`（用户上传的原始文件）和 `artifacts/`（Agent 产出的文件）
配上自动过期规则（分别是 30 天和 90 天），避免存储无限增长——这是一次性
的操作，不需要跟着每次部署重新跑。

### 联网搜索 —— Tavily

Agent 的 `web_search` 工具会调用 [Tavily](https://tavily.com)（有免费额度）
来给计划/建议提供真实依据，而不是凭空编造。设置 `TAVILY_API_KEY`；
不设置的话，这个工具会明确返回"未配置"的错误，而不是悄悄失败。

### 登录 —— 真实账号，不支持自助注册

网页控制台需要登录才能访问（用户名 + 密码 + 一个签名过的 `httpOnly`
会话 cookie）。账号存在 `users` 表里（密码用 `scrypt` 哈希，从不明文
存储，也不放在环境变量里）—— 没有注册页面也没有找回密码，所以账号需要
手动创建：

```bash
cd apps/server && pnpm create-user <username> <password>
```

在服务端设置 `AUTH_SESSION_SECRET` 即可强制要求登录；如果不设置，控制台
（以及 `/api/agent/run`）会以开放模式运行，这只适合本地开发用。
`AUTH_SESSION_SECRET` 应该是一个足够长的随机字符串 —— 它用来给会话
cookie 签名。

### 每日花费上限

每个账号每天（滚动 24 小时窗口，不是自然日）最多能花 `DAILY_COST_LIMIT_USD`
美元（默认 5），按 OpenRouter 每次请求返回的真实花费（`usage.cost`）累计，
不是估算的 token 数。超过之后，新对话会直接被拒绝（`429`），当前正在跑的
对话不会被中途打断；额度会随时间自然滚动恢复，不需要手动重置。只在设置了
`AUTH_SESSION_SECRET`（要求登录）时才生效——本地开发不受影响。

## 说明

- 每个账号有每日花费上限（见上面"每日花费上限"一节），但仍然是按账号算的——同一个账号的多个会话共享同一份额度，不是按会话单独限制。
- Turborepo 按包做构建缓存：只改 `apps/web` 不会触发 `apps/server` 重新构建，反之亦然。
