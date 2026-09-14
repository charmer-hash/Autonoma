import { Hono } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'
import type { AuthMeResponse, LoginRequest, PublicKeyResponse } from '@autonoma/shared'
import { authenticate, clearSession, createSession, getOwnerId, isAuthenticated } from '../auth.js'
import { decryptPassword, getPublicKeyBase64 } from '../lib/login-crypto.js'
import { checkLoginRateLimit, clearLoginAttempts, recordLoginFailure, resolveClientIp } from '../lib/login-rate-limit.js'
import { getUsernameById } from '../db/users.js'

export const authRouter = new Hono()

authRouter.get('/public-key', (c) => c.json({ publicKey: getPublicKeyBase64() } satisfies PublicKeyResponse))

authRouter.post('/login', async (c) => {
  const ip = resolveClientIp(c.req.header('x-forwarded-for'), getConnInfo(c).remote.address)
  const rate = checkLoginRateLimit(ip)
  if (!rate.allowed) return c.json({ error: `登录尝试过于频繁，请 ${Math.ceil(rate.retryAfterMs / 60_000)} 分钟后重试。` }, 429)
  const body = await c.req.json<Partial<LoginRequest>>().catch(() => ({}) as Partial<LoginRequest>)
  let decryptedPassword: string
  try { decryptedPassword = decryptPassword(body.password) }
  catch (err) { recordLoginFailure(ip); return c.json({ error: err instanceof Error ? err.message : '登录请求格式不正确。' }, 400) }
  const ownerId = await authenticate(body.username, decryptedPassword)
  if (!ownerId) { recordLoginFailure(ip); return c.json({ error: '用户名或密码错误' }, 401) }
  clearLoginAttempts(ip)
  await createSession(c, ownerId)
  return c.json({ ok: true })
})

authRouter.post('/logout', (c) => { clearSession(c); return c.json({ ok: true }) })

authRouter.get('/me', async (c) => {
  const authenticated = await isAuthenticated(c)
  if (!authenticated) return c.json({ authenticated } satisfies AuthMeResponse)
  const ownerId = await getOwnerId(c)
  const username = ownerId ? await getUsernameById(ownerId) : undefined
  return c.json({ authenticated, username } satisfies AuthMeResponse)
})
