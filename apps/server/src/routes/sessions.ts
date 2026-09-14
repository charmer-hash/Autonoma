import { Hono } from 'hono'
import { requireAuth, getOwnerId } from '../auth.js'
import { MAX_SESSION_NAME_LENGTH, type ListSessionsResponse, type RenameSessionRequest, type SessionMessageCountResponse } from '@autonoma/shared'
import { listSessions, loadSessionMessages, getSessionMessageCount, resolveSessionAccess, renameSession, deleteSession } from '../db/sessions.js'
import { isRunInProgress, markSessionDeleting, clearSessionDeleting } from '../agent/active-runs.js'

export const sessionsRouter = new Hono()

sessionsRouter.get('/', requireAuth, async (c) => {
  const ownerId = await getOwnerId(c)
  const rawLimit = Number(c.req.query('limit')); const rawOffset = Number(c.req.query('offset'))
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 && rawLimit <= 100 ? rawLimit : 50
  const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0
  const { sessions, hasMore } = await listSessions(ownerId, { limit, offset, search: c.req.query('search') })
  return c.json({ sessions: sessions.map((s) => ({ ...s, updatedAt: s.updatedAt.toISOString() })), hasMore } satisfies ListSessionsResponse)
})

async function access(c: any, id: string, ownerId: string) {
  const a = await resolveSessionAccess(id, ownerId)
  if (a === 'forbidden') return c.json({ error: '无权访问该会话。' }, 403)
  if (a === 'not_found') return c.json({ error: '会话不存在。' }, 404)
  return null
}

sessionsRouter.get('/:id', requireAuth, async (c) => { const id=c.req.param('id'); if(!id)return c.json({error:'Missing session id.'},400); const owner=await getOwnerId(c); const e=await access(c,id!,owner!); if(e)return e; return c.json({messages: await loadSessionMessages(id!,owner!)}) })
sessionsRouter.get('/:id/messages/count', requireAuth, async (c) => { const id=c.req.param('id'); if(!id)return c.json({error:'Missing session id.'},400); const owner=await getOwnerId(c); const e=await access(c,id!,owner!); if(e)return e; return c.json({count: await getSessionMessageCount(id!)} satisfies SessionMessageCountResponse) })
sessionsRouter.patch('/:id', requireAuth, async (c) => { const id=c.req.param('id'); if(!id)return c.json({error:'Missing session id.'},400); const owner=await getOwnerId(c); const e=await access(c,id!,owner!); if(e)return e; const body=await c.req.json<Partial<RenameSessionRequest>>().catch(()=>({} as Partial<RenameSessionRequest>)); const name=typeof body.name==='string'?body.name.trim():''; if(name.length>MAX_SESSION_NAME_LENGTH)return c.json({error:`标题过长，最多 ${MAX_SESSION_NAME_LENGTH} 个字符。`},400); await renameSession(id!,name||null); return c.json({ok:true}) })
sessionsRouter.delete('/:id', requireAuth, async (c) => { const id=c.req.param('id'); if(!id)return c.json({error:'Missing session id.'},400); const owner=await getOwnerId(c); const e=await access(c,id!,owner!); if(e)return e; if(isRunInProgress(id!))return c.json({error:'该会话有一条消息正在处理中，请稍候再试。'},409); markSessionDeleting(id!); try{await deleteSession(id!)}finally{clearSessionDeleting(id!)} return c.json({ok:true}) })
