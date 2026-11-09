// Run with the server .env loaded. Creates two temporary users and removes them afterward.
import assert from 'node:assert/strict'
import { generateSignedCookie } from 'hono/cookie'
import { app } from '../src/index.js'
import { pool } from '../src/db/client.js'

const secret = process.env.AUTH_SESSION_SECRET
if (!secret) throw new Error('AUTH_SESSION_SECRET must be configured for the ownership test')
const userA = crypto.randomUUID()
const userB = crypto.randomUUID()
const ids = [userA, userB]
let baseId: string | undefined

async function request(path: string, method: string, owner: string, body?: unknown) {
  const cookie = await generateSignedCookie('session', owner, secret!, { path: '/' })
  return app.request(path, { method, headers: {
    Cookie: cookie, 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest',
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}

try {
  await pool.query('INSERT INTO users (id,username,password_hash) VALUES ($1,$2,$3),($4,$5,$6)', [
    userA, `knowledge-smoke-a-${userA}`, 'unused', userB, `knowledge-smoke-b-${userB}`, 'unused',
  ])
  const create = await request('/api/knowledge/bases', 'POST', userA, { name: 'private-smoke' })
  assert.equal(create.status, 201)
  baseId = (await create.json() as { base: { id: string } }).base.id

  const own = await request('/api/knowledge/bases', 'GET', userA)
  assert.ok((await own.json() as { bases: { id: string }[] }).bases.some((base) => base.id === baseId))
  const other = await request('/api/knowledge/bases', 'GET', userB)
  assert.ok(!(await other.json() as { bases: { id: string }[] }).bases.some((base) => base.id === baseId))
  assert.equal((await request(`/api/knowledge/bases/${baseId}/documents`, 'GET', userB)).status, 404)
  assert.equal((await request(`/api/knowledge/bases/${baseId}/search`, 'POST', userB, { query: 'private' })).status, 403)
  assert.equal((await request(`/api/knowledge/bases/${baseId}`, 'DELETE', userB)).status, 404)
  console.log('ownership: second user cannot list, read, search or delete first user base')
} finally {
  if (baseId) await request(`/api/knowledge/bases/${baseId}`, 'DELETE', userA).catch((err) => console.error('base cleanup failed:', err))
  await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [ids]).catch((err) => console.error('user cleanup failed:', err))
  await pool.end()
}
