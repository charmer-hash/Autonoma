import { randomUUID } from 'node:crypto'
import { stdin, stdout } from 'node:process'
import { db } from '../src/db/client.js'
import { hashPassword } from '../src/lib/password.js'
import { users } from '../src/db/schema.js'

// 密码故意不通过命令行参数传入——argv 会明文留在 shell 历史记录里，
// 运行期间也能被同一台机器上的其他进程通过 `ps aux`/`/proc/<pid>/cmdline`
// 看到。用户名不敏感，仍然可以作为参数传；密码统一走下面的隐藏式 stdin
// 交互输入，跟登录接口"密码从不以明文形式落地在任何持久化介质"的
// 安全水准保持一致。
const username = process.argv[2]
if (!username) {
  console.error('Usage: pnpm create-user <username>（回车后会提示交互式输入密码）')
  process.exit(1)
}

const password = await promptHidden('Password: ')
if (!password) {
  console.error('密码不能为空。')
  process.exit(1)
}

await db.insert(users).values({ id: randomUUID(), username, passwordHash: await hashPassword(password) })
console.log(`Created user "${username}".`)
process.exit(0)

// 手写而不是引入 prompts/inquirer 之类的第三方包——这是一个只有几行的
// 一次性管理脚本，不值得为此新增一个生产依赖。逐字符读取 stdin 原始
// 输入、不回显任何字符（既不显示明文也不显示掩码星号），效果等同于
// 大多数 CLI 工具的密码输入体验（比如 sudo/ssh）。
async function promptHidden(question: string): Promise<string> {
  const CTRL_D = '\x04'
  const CTRL_C = '\x03'
  const BACKSPACE = '\x7f'

  return new Promise((resolve) => {
    stdout.write(question)
    const wasRaw = stdin.isTTY ? stdin.isRaw : undefined
    stdin.resume()
    stdin.setEncoding('utf8')
    if (stdin.isTTY) stdin.setRawMode(true)

    let input = ''
    function cleanup() {
      stdin.removeListener('data', onData)
      if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false)
      stdin.pause()
    }
    function onData(chunk: string) {
      for (const char of chunk) {
        if (char === '\n' || char === '\r' || char === CTRL_D) {
          cleanup()
          stdout.write('\n')
          resolve(input)
          return
        }
        if (char === CTRL_C) {
          // 原样退出，不留下半截输入的进程。
          cleanup()
          stdout.write('\n')
          process.exit(1)
        }
        if (char === BACKSPACE || char === '\b') {
          input = input.slice(0, -1)
          continue
        }
        input += char
      }
    }
    stdin.on('data', onData)
  })
}
