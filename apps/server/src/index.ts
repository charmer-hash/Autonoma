import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamText } from 'hono/streaming'

const app = new Hono()

app.use(
  '*',
  cors({
    origin: process.env.CORS_ORIGIN?.split(',') ?? '*',
  }),
)

app.get('/health', (c) => c.json({ ok: true }))

// Placeholder streaming endpoint — wire this up to the real agent loop.
app.get('/api/agent/stream', (c) => {
  return streamText(c, async (stream) => {
    for (const chunk of ['Hello', ' from', ' the', ' agent', ' server.']) {
      await stream.write(chunk)
      await stream.sleep(200)
    }
  })
})

const port = Number(process.env.PORT ?? 8787)

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Server listening on http://localhost:${info.port}`)
})
