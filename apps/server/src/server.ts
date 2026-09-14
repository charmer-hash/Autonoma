import { serve } from '@hono/node-server'
import { app } from './index.js'
import { runMigrations } from './db/migrate.js'
await runMigrations()
const port = Number(process.env.PORT ?? 8787)
serve({ fetch: app.fetch, port }, (info) => console.log(`Server listening on http://localhost:${info.port}`))
