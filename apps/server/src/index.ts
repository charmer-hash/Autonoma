import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { Sandbox } from 'e2b'
import { runAgentLoop } from './agent/loop.js'

const app = new Hono()

app.use(
  '*',
  cors({
    origin: process.env.CORS_ORIGIN?.split(',') ?? '*',
  }),
)

app.get('/health', (c) => c.json({ ok: true }))

app.post('/api/agent/run', async (c) => {
  const body = await c.req.json<{ task?: string }>().catch(() => ({}) as { task?: string })
  const task = body.task?.trim()
  if (!task) {
    return c.json({ error: 'Missing "task" in request body.' }, 400)
  }

  return streamSSE(
    c,
    async (stream) => {
      const sandbox = await Sandbox.create()
      try {
        for await (const event of runAgentLoop(task, sandbox)) {
          await stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
        }
      } finally {
        await sandbox.kill()
      }
    },
    // hono/streaming sends its own `event: error` with `data: <message>` after this runs.
    async (error) => {
      console.error(error)
    },
  )
})

const port = Number(process.env.PORT ?? 8787)

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Server listening on http://localhost:${info.port}`)
})
