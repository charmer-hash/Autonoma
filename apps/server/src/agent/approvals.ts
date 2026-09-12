// 审批模式（AgentSettings.approvalMode === 'confirm'）下，run_command/write_file/
// export_artifact 这几个会改动沙箱状态的工具在真正执行前会挂起等待用户确认——
// 这里维护的是等待中的 Promise resolver，不落库、不跨进程：SSE 连接本身就在
// 同一个进程里挂着等待（见 agent/loop.ts），进程重启导致等待中的批准全部失效
// 是可接受的，跟 sessionId 关联的沙箱这类"进程内易失状态"处理方式一致。
const pending = new Map<string, (approved: boolean) => void>()

// key 建议用 `${sessionId}:${toolCallId}`，避免不同会话里偶然撞上相同的
// tool_call id。超时未处理时按"拒绝"处理，而不是让等待永远挂着——否则
// 对应的 SSE 连接和沙箱会跟着无限期占用。
export function waitForApproval(key: string, timeoutMs = 5 * 60_000, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (approved: boolean) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      pending.delete(key)
      resolve(approved)
    }
    const onAbort = () => finish(false)
    const timer = setTimeout(() => {
      pending.delete(key)
      signal?.removeEventListener('abort', onAbort)
      resolve(false)
    }, timeoutMs)
    pending.set(key, finish)
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// 返回 false 表示这个 key 当前没有正在等待的批准（已经被处理过、已超时，
// 或者压根不是审批模式下的调用）——调用方据此可以给出"已过期/已处理"之类的提示。
export function resolveApproval(key: string, approved: boolean): boolean {
  const resolve = pending.get(key)
  if (!resolve) return false
  resolve(approved)
  return true
}
