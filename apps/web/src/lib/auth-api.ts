import type { AuthMeResponse, LoginRequest } from '@autonoma/shared'
import { apiFetch, readErrorMessage } from './api-client'
import { encryptPassword } from './login-crypto'

export async function checkAuth(): Promise<AuthMeResponse> {
  try {
    const res = await apiFetch('/api/auth/me')
    if (!res.ok) return { authenticated: false }
    const data = (await res.json()) as AuthMeResponse
    return { authenticated: Boolean(data.authenticated), username: data.username }
  } catch {
    return { authenticated: false }
  }
}

export async function login(username: string, password: string): Promise<{ ok: boolean; error?: string }> {
  let encryptedPassword: string
  try {
    encryptedPassword = await encryptPassword(password)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '加密登录信息失败，请重试' }
  }

  // apiFetch 是裸 fetch，网络异常（离线、DNS 失败等）会直接 reject，
  // 而不是返回一个 !ok 的 Response——不包一层 try/catch 的话，这个异常
  // 会一路抛到 LoginPage 的 handleSubmit，导致 setSubmitting(false) 永远
  // 不会执行，登录按钮卡在"提交中"且没有任何报错，只能刷新页面才能恢复。
  try {
    const res = await apiFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 线上字段名叫 password，但值是上面加密出来的密文，不是明文——
      // 变量名保留 encryptedPassword 是为了让这段代码本身别把这个事实
      // 弄丢，跟服务端约定的字段名（LoginRequest.password）是两回事。
      body: JSON.stringify({ username, password: encryptedPassword } satisfies LoginRequest),
    })
    if (res.ok) return { ok: true }
    return { ok: false, error: await readErrorMessage(res, '登录失败，请重试') }
  } catch {
    return { ok: false, error: '网络连接失败，请检查网络后重试。' }
  }
}

export async function logout(): Promise<void> {
  // 退出登录本质上是"尽力而为"——即使这次请求失败（网络异常），用户仍然
  // 想要、也应该在本地退出登录，调用方（App.tsx）后续还会清空本地会话
  // 状态；这里吞掉异常，不让一次网络抖动挡住整个退出流程。
  await apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
}
