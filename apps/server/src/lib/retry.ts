// 对外部调用中的瞬时故障（网络抖动、服务提供方不稳定）进行重试 ——
// 例如 e2b 沙箱创建、Tavily 搜索。不适用于本身已经会重试的调用
// （OpenAI SDK 默认会对 429/5xx 自动重试）。
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 500): Promise<T> {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * (i + 1)))
      }
    }
  }
  throw lastError
}
