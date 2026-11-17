import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import { Hono } from 'hono'
import * as Sentry from '@sentry/hono/node'
import type { ApiEnv } from '../src/app-setup.js'

test('5xx responses log safe response details without request data', async () => {
  const previousDsn = process.env.SENTRY_DSN
  const previousDatabaseUrl = process.env.DATABASE_URL
  process.env.SENTRY_DSN = 'https://public@example.invalid/1'
  process.env.DATABASE_URL = 'postgres://localhost/sentry-test'
  const log = mock.method(Sentry.logger, 'error')

  try {
    const { configureApp } = await import('../src/app-setup.js')
    const app = new Hono<ApiEnv>()
    configureApp(app)
    app.get('/private/:id', (c) => {
      c.set('sentryResponseError', '服务暂时不可用。')
      c.set('sentryFailureType', 'DatabaseError')
      return c.json({ error: '服务暂时不可用。', private: 'response-secret' }, 500)
    })
    app.get('/bad-request', (c) => c.json({ error: 'bad input' }, 400))
    app.get('/explode', () => { throw new Error('private-cause') })

    const response = await app.request('http://localhost/private/sensitive-id?token=request-secret')
    assert.equal(response.status, 500)
    await app.request('http://localhost/bad-request')
    assert.equal((await app.request('http://localhost/explode')).status, 500)

    assert.equal(log.mock.callCount(), 2)
    const [message, fields] = log.mock.calls[0]!.arguments
    assert.equal(message, 'API request failed')
    assert.deepEqual(fields, {
      method: 'GET',
      route: '/private/:id',
      status: 500,
      response_error: '服务暂时不可用。',
      reason_type: 'DatabaseError',
    })
    assert.doesNotMatch(JSON.stringify(fields), /sensitive-id|request-secret|response-secret/)
    assert.deepEqual(log.mock.calls[1]!.arguments[1], {
      method: 'GET',
      route: '/explode',
      status: 500,
      response_error: 'Internal Server Error',
      reason_type: 'Error',
    })
    assert.doesNotMatch(JSON.stringify(log.mock.calls[1]!.arguments[1]), /private-cause/)
  } finally {
    log.mock.restore()
    if (previousDsn === undefined) delete process.env.SENTRY_DSN
    else process.env.SENTRY_DSN = previousDsn
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previousDatabaseUrl
  }
})
