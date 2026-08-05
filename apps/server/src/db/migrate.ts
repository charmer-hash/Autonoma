import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { db, pool } from './client.js'

// drizzle 自己的 migrate() 在"读取上一条已应用的迁移"和"真正执行本次
// 迁移"之间没有加任何锁（读取是池里随便一个连接上的一次性查询，之后
// 才另开一个事务去跑）。Railway 的滚动发布经常会让新旧两个实例短暂
// 同时活着（新实例健康检查通过之前旧的不会被杀掉），两边同时启动、
// 同时读到同一条迁移"还没跑过"、同时去跑同一条 DDL 完全可能发生——如果
// 这条迁移不是幂等的（比如普通的 ADD COLUMN，没有 IF NOT EXISTS），
// 后提交的那个事务会直接报错，对应那个实例就直接启动失败退出。
//
// 用 pg_advisory_lock 把整个迁移过程串行化：从 pool 里单独签出一个专用
// 连接来持有这把会话级锁，全程占用、不释放回池子，直到迁移完成（无论
// 成功还是失败）才显式 unlock 并归还——advisory lock 是按连接/会话生效
// 的，加锁和解锁必须是同一个连接，所以不能通过 drizzle 的 db.execute
// 去拿（那背后是连接池，每次查询可能落在不同连接上）。另一个实例这期间
// 调用同一把锁会阻塞等待，而不是跟这边抢跑同一条 DDL。锁 key 是随便选的
// 一个固定数字，只要在这个项目里不跟其它用途的 advisory lock 撞车就行
// （目前项目里没有别的地方用到）。
const MIGRATION_LOCK_KEY = 8825170

export async function runMigrations(): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY])
    try {
      await migrate(db, { migrationsFolder: 'drizzle' })
    } finally {
      await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
    }
  } finally {
    client.release()
  }
}
