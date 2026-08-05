// 挡住"对着登录接口狂刷用户名/密码组合"这类最基本的暴力破解——不是
// 完整的账号安全体系,只是最后一道摩擦力。纯内存态、单进程,和
// agent/active-runs.ts 的运行态、agent/approvals.ts 的等待中批准 Map
// 是同一类"单实例部署下可接受"的设计,不做跨进程持久化,重启后重置。
//
// 按来源 IP 计数,而不是按用户名——按用户名计数虽然更"精准"，但会让
// 攻击者可以故意用别人的用户名连续失败登录,把这个账号的登录功能
// 拒绝服务掉；按 IP 计数不会有这个副作用，代价是共享同一出口 IP 的
// 多个真实用户会共用同一份配额（对于这种小规模自建部署可以接受）。

type Attempt = { count: number; windowStartedAt: number; lockedUntil?: number }

const attempts = new Map<string, Attempt>()

const WINDOW_MS = 15 * 60_000 // 失败计数的滑动窗口
const MAX_ATTEMPTS = 10 // 窗口内允许的失败次数上限
const LOCKOUT_MS = 15 * 60_000 // 超过上限后锁定多久

// 登录请求进来时先调用——如果被锁定，调用方应直接拒绝、不要再去跑
// scrypt 比对，省下无意义的 CPU 开销。
export function checkLoginRateLimit(key: string): { allowed: true } | { allowed: false; retryAfterMs: number } {
  const entry = attempts.get(key)
  if (!entry?.lockedUntil) return { allowed: true }
  const remaining = entry.lockedUntil - Date.now()
  if (remaining <= 0) return { allowed: true }
  return { allowed: false, retryAfterMs: remaining }
}

// 登录失败（不管是密码错、用户名不存在，还是请求格式本身就不对）后
// 调用——递增这个来源在当前窗口内的失败计数，达到上限就锁定一段时间。
export function recordLoginFailure(key: string): void {
  const now = Date.now()
  const entry = attempts.get(key)
  if (!entry || now - entry.windowStartedAt > WINDOW_MS) {
    attempts.set(key, { count: 1, windowStartedAt: now })
    return
  }
  entry.count++
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = now + LOCKOUT_MS
  }
}

// 从未达到锁定上限的失败记录不会被 clearLoginAttempts 清掉（那个只在
// 登录成功时调用），窗口过期后也不会自动消失，只会在同一个 key 再次
// 失败时才被覆盖——定期扫一遍，把窗口和锁定都已经过期的陈旧记录清掉，
// 避免这个 Map 在长期运行的进程里无限增长。
const CLEANUP_INTERVAL_MS = 30 * 60_000
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of attempts) {
    const expired = entry.lockedUntil ? now > entry.lockedUntil : now - entry.windowStartedAt > WINDOW_MS
    if (expired) attempts.delete(key)
  }
}, CLEANUP_INTERVAL_MS).unref()

// 登录成功后调用——清掉这个来源的失败记录，不让它们跨会话累积。
export function clearLoginAttempts(key: string): void {
  attempts.delete(key)
}

// Railway（以及大多数反向代理部署）在进程前面有一层边缘代理，socket 层面
// 拿到的对端地址是代理自己的内部地址，不是真实客户端 IP——如果直接拿它
// 当限流 key，所有用户的登录请求会落到同一个 key 上，任何一个人连续输错
// 密码几次就会把全站登录锁掉。边缘代理转发请求时会在 X-Forwarded-For
// 末尾追加它自己看到的连接方地址，所以取这个头的最后一段，而不是第一段
// ——第一段是客户端在原始请求里就能任意塞入的值，伪造不了的只有代理自己
// 追加的最后一段（这个假设只在"只有一层受信任代理"时成立，多层代理需要
// 相应调整取倒数第几段）。本地开发没有代理、没有这个头，落回 socket 对端
// 地址（这时它就是真实的直连地址）。
export function resolveClientIp(forwardedFor: string | null | undefined, socketAddress: string | undefined): string {
  if (forwardedFor) {
    const parts = forwardedFor
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (parts.length > 0) return parts[parts.length - 1]
  }
  return socketAddress ?? 'unknown'
}
