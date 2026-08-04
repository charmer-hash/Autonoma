import { and, desc, eq } from 'drizzle-orm'
import { withRetry } from '../lib/retry.js'
import { db } from './client.js'
import { attachments } from './schema.js'

export type NewAttachment = {
  id: string
  sessionId: string
  filename: string
  mimeType: string
  size: number
  r2Key: string
}

export async function insertAttachment(attachment: NewAttachment): Promise<void> {
  await withRetry(() => db.insert(attachments).values(attachment))
}

export type AttachmentRow = {
  id: string
  sessionId: string
  filename: string
  mimeType: string
  size: number
  r2Key: string
}

// A session can have more than one row for the same filename (the user
// uploaded two different files with the same name at different times) —
// the latest one is whichever the sandbox's file at that name would
// currently correspond to.
export async function getLatestAttachmentByFilename(sessionId: string, filename: string): Promise<AttachmentRow | undefined> {
  const rows = await withRetry(() =>
    db
      .select({
        id: attachments.id,
        sessionId: attachments.sessionId,
        filename: attachments.filename,
        mimeType: attachments.mimeType,
        size: attachments.size,
        r2Key: attachments.r2Key,
      })
      .from(attachments)
      .where(and(eq(attachments.sessionId, sessionId), eq(attachments.filename, filename)))
      .orderBy(desc(attachments.createdAt))
      .limit(1),
  )
  return rows[0]
}
