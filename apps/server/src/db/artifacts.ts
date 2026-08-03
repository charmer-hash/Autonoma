import { eq } from 'drizzle-orm'
import { withRetry } from '../lib/retry.js'
import { db } from './client.js'
import { artifacts } from './schema.js'

export type NewArtifact = {
  id: string
  sessionId: string
  name: string
  mimeType: string
  size: number
  r2Key: string
}

export async function insertArtifact(artifact: NewArtifact): Promise<void> {
  await withRetry(() => db.insert(artifacts).values(artifact))
}

export type ArtifactRow = {
  id: string
  sessionId: string
  name: string
  mimeType: string
  size: number
  r2Key: string
}

export async function getArtifactById(id: string): Promise<ArtifactRow | undefined> {
  const rows = await withRetry(() =>
    db
      .select({
        id: artifacts.id,
        sessionId: artifacts.sessionId,
        name: artifacts.name,
        mimeType: artifacts.mimeType,
        size: artifacts.size,
        r2Key: artifacts.r2Key,
      })
      .from(artifacts)
      .where(eq(artifacts.id, id))
      .limit(1),
  )
  return rows[0]
}
