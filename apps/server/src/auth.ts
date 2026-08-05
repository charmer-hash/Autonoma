import type { Context, Next } from 'hono'
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie'
import { findUserIdByCredentials } from './db/users.js'

const SESSION_COOKIE = 'session'
const SESSION_MAX_AGE = 60 * 60 * 24 * 7 // 7 天

// 生产环境下前后端跨站（域名不同）需要 SameSite=None，而浏览器
// 只有在同时带 Secure 的情况下才会认可这个设置——而 Secure cookie
// 不会通过普通 http 发送，本地开发用的正是普通 http。
// 导出给 index.ts 复用（比如 CORS_ORIGIN 的生产环境强制校验），
// 避免"是不是生产环境"这个判断在两个地方各写一份、以后各自漂移。
export const isProd = process.env.NODE_ENV === 'production'

// 账号信息存放在 users 表里（参见 scripts/create-user.ts）——这个
// 标志只决定是否要强制启用登录/归属校验，所以本地开发时即使
// 没有预先创建用户，也依然可以完全开放地运行。
function authConfigured(): boolean {
  return Boolean(process.env.AUTH_SESSION_SECRET)
}

// 匹配成功时返回该用户的 id，否则返回 undefined。
export async function authenticate(username: unknown, password: unknown): Promise<string | undefined> {
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return undefined
  }
  return findUserIdByCredentials(username, password)
}

// cookie 的值就是通过身份验证的用户 id——它同时也充当会话绑定的
// "owner"（参见 db/sessions.ts 的 resolveSessionAccess），在多次
// 登录之间保持稳定，意味着同一用户退出再登录不会导致之前的
// 会话变成孤儿。
export async function createSession(c: Context, ownerId: string): Promise<void> {
  const secret = process.env.AUTH_SESSION_SECRET!
  await setSignedCookie(c, SESSION_COOKIE, ownerId, secret, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'None' : 'Lax',
    path: '/',
    maxAge: SESSION_MAX_AGE,
  })
}

export function clearSession(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
}

export async function isAuthenticated(c: Context): Promise<boolean> {
  if (!authConfigured()) return true // 未设置凭据——鉴权处于关闭状态（本地开发默认情况）
  return Boolean(await getOwnerId(c))
}

// 当鉴权关闭（没有归属需要校验）或 cookie 缺失/无效时返回
// undefined——调用方应把这种情况当作"没有 owner"处理。
export async function getOwnerId(c: Context): Promise<string | undefined> {
  if (!authConfigured()) return undefined
  const value = await getSignedCookie(c, process.env.AUTH_SESSION_SECRET!, SESSION_COOKIE)
  return typeof value === 'string' ? value : undefined
}

export async function requireAuth(c: Context, next: Next) {
  if (!authConfigured()) {
    console.warn('AUTH_SESSION_SECRET not set — running without auth.')
    return next()
  }
  if (!(await isAuthenticated(c))) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  return next()
}
