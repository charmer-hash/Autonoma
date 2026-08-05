import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from './schema.js'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required.')
}

// 单独导出——db/migrate.ts 需要从池里签出一个专用连接来持有
// pg_advisory_lock（会话级锁必须在同一个连接上加锁/解锁，不能通过
// drizzle 的 db.execute 去拿，那背后是连接池，每次查询可能落在不同
// 连接上）。
export const pool = new Pool({ connectionString: databaseUrl })

export const db = drizzle(pool, { schema })
