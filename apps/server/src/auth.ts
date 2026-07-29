import type { Context, Next } from 'hono'
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie'
import { findUserIdByCredentials } from './db/users.js'

const SESSION_COOKIE = 'session'
const SESSION_MAX_AGE = 60 * 60 * 24 * 7 // 7 days

// Cross-site in production (separate frontend/backend domains) needs
// SameSite=None, which browsers only honor alongside Secure — and Secure
// cookies aren't sent over plain http, which local dev uses.
const isProd = process.env.NODE_ENV === 'production'

// Accounts live in the users table (see scripts/create-user.ts) — this flag
// only gates whether login/ownership is enforced at all, so local dev can
// still run wide open without seeding a user first.
function authConfigured(): boolean {
  return Boolean(process.env.AUTH_SESSION_SECRET)
}

// Returns the matched user's id on success, undefined otherwise.
export async function authenticate(username: unknown, password: unknown): Promise<string | undefined> {
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return undefined
  }
  return findUserIdByCredentials(username, password)
}

// The cookie value is the authenticated user's id — it doubles as the
// "owner" a conversation session gets bound to (see db/sessions.ts's
// resolveSessionAccess), and staying stable across logins means logging out
// and back in as the same user doesn't orphan their previous sessions.
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
  if (!authConfigured()) return true // no credentials set — auth is off (local dev default)
  return Boolean(await getOwnerId(c))
}

// undefined when auth is off (nothing to enforce ownership against) or the
// cookie is missing/invalid — callers should treat that as "no owner".
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
