import { randomUUID } from 'node:crypto'
import { db } from '../src/db/client.js'
import { hashPassword } from '../src/lib/password.js'
import { users } from '../src/db/schema.js'

const [username, password] = process.argv.slice(2)
if (!username || !password) {
  console.error('Usage: pnpm create-user <username> <password>')
  process.exit(1)
}

await db.insert(users).values({ id: randomUUID(), username, passwordHash: await hashPassword(password) })
console.log(`Created user "${username}".`)
process.exit(0)
