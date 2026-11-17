import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import * as Sentry from '@sentry/hono/node'
import { sentry } from '@sentry/hono/node'
import { isProd } from './auth.js'

export type ApiEnv = {
  Variables: {
    sentryResponseError?: string
    sentryFailureType?: string
  }
}

/** Configure process-wide middleware shared by all HTTP routes. */
export function configureApp(app: Hono<ApiEnv>): void {
  const corsOrigin = process.env.CORS_ORIGIN?.split(',')
  if (isProd && !corsOrigin) {
    throw new Error('CORS_ORIGIN 未设置——生产环境必须显式配置允许的跨域来源，而不是回退到会静默破坏所有登录态请求的通配符。')
  }

  if (process.env.SENTRY_DSN) {
    app.use('*', sentry(app))
    app.use('*', async (c, next) => {
      await next()
      if (c.res.status < 500) return
      Sentry.logger.error('API request failed', {
        method: c.req.method,
        route: c.req.routePath || 'unknown',
        status: c.res.status,
        response_error: c.get('sentryResponseError') ?? 'Internal Server Error',
        reason_type: c.get('sentryFailureType') ?? c.error?.name ?? 'ServerError',
      })
    })
  }
  app.use('*', logger())
  app.use('*', cors({ origin: corsOrigin ?? '*', credentials: true }))
  app.use('*', async (c, next) => {
    const method = c.req.method
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && c.req.header('X-Requested-With') !== 'XMLHttpRequest') {
      return c.json({ error: '缺少必要的请求头。' }, 403)
    }
    await next()
  })
}
