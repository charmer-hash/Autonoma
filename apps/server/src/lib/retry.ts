// Retries transient failures (network blips, a flaky provider) in external
// calls — e2b sandbox creation, Tavily search. Not for calls that already
// retry themselves (the OpenAI SDK retries 429/5xx by default).
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
