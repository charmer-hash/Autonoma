import { useEffect, useState } from 'react'
import { useLocalStorageState } from 'ahooks'
import { last as lastOf } from 'lodash-es'
import type { SessionSummary, UploadedAttachment } from '@autonoma/shared'
import type { Block } from '@/types/blocks'
import { runAgent } from '@/lib/agent-api'
import { getSessionMessages, listSessions } from '@/lib/sessions-api'
import { messagesToBlocks } from '@/lib/blocks'
import { readSessionIdFromUrl, syncSessionIdToUrl } from '@/lib/session-url'

export function useConsoleSession() {
  const [task, setTask] = useState('')
  const [blocks, setBlocks] = useState<Block[]>([])
  const [running, setRunning] = useState(false)
  // sessionId 由服务端签发，客户端从不自行选取（见
  // apps/server/src/index.ts）。同时保存在 URL 的 ?session= 参数中（这样
  // 一段对话可以被收藏/分享后直接重新打开）以及
  // localStorage 中——通过 ahooks 的 useLocalStorageState——（这样即使
  // 没有该参数的普通刷新也能继续上一次的对话）。两者都存在时以 URL 为准。
  const [storedSessionId, setStoredSessionId] = useLocalStorageState<string | undefined>('sessionId')
  const initialSessionId = readSessionIdFromUrl() ?? storedSessionId
  const [sessionId, setSessionId] = useState<string | undefined>(initialSessionId)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(true)
  // 只要存在待恢复的 sessionId，初始值就为 true，这样控制台会显示加载状态，
  // 而不是对一个实际上有历史记录的会话短暂闪现"暂无消息"的空状态。
  const [messagesLoading, setMessagesLoading] = useState(Boolean(initialSessionId))

  function setActiveSessionId(id: string | undefined) {
    setStoredSessionId(id)
    syncSessionIdToUrl(id)
    setSessionId(id)
  }

  async function refreshSessions() {
    try {
      setSessions(await listSessions())
    } catch (err) {
      console.error('failed to load sessions:', err)
    } finally {
      setSessionsLoading(false)
    }
  }

  // 在页面刷新时恢复对话——sessionId 保存在 localStorage/URL 中得以留存，
  // 但 `blocks` 不会保留，所以如果没有这段逻辑，刷新会显示空的控制台，
  // 尽管服务端仍保留着历史记录。
  useEffect(() => {
    refreshSessions()
    // 如果 sessionId 只是来自 localStorage 兜底（URL 中还没有 ?session=），
    // 也把它同步到 URL 中，使其能立即被分享。
    if (sessionId && readSessionIdFromUrl() !== sessionId) {
      syncSessionIdToUrl(sessionId)
    }
    if (sessionId) {
      getSessionMessages(sessionId)
        .then((messages) => setBlocks(messagesToBlocks(messages)))
        .catch((err) => appendError(err instanceof Error ? err.message : String(err)))
        .finally(() => setMessagesLoading(false))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function appendText(delta: string) {
    setBlocks((prev) => {
      const last = lastOf(prev)
      if (last?.kind === 'text') {
        return [...prev.slice(0, -1), { kind: 'text', text: last.text + delta }]
      }
      return [...prev, { kind: 'text', text: delta }]
    })
  }

  function startTool(id: string, name: string, args: unknown) {
    setBlocks((prev) => [...prev, { kind: 'tool', id, name, args, status: 'running' }])
  }

  // 按 id 匹配，而不是"最后一个 block"——SSE 的 tool_call/tool_result
  // 事件携带着与对应 tool_call 相同的 id，所以即使关于顺序的假设以后
  // 发生变化，这里依然是正确的。
  function finishTool(id: string, result: string) {
    setBlocks((prev) => {
      const idx = prev.findIndex((b) => b.kind === 'tool' && b.id === id)
      if (idx === -1) return prev
      return [...prev.slice(0, idx), { ...(prev[idx] as Extract<Block, { kind: 'tool' }>), result, status: 'done' }, ...prev.slice(idx + 1)]
    })
  }

  function appendError(text: string) {
    setBlocks((prev) => [...prev, { kind: 'error', text }])
  }

  function appendDocument(name: string, content: string) {
    setBlocks((prev) => [...prev, { kind: 'document', name, content }])
  }

  // export_artifact 总是先发出一个运行中的工具卡片（见 loop.ts），所以
  // 这里是把那个卡片替换成 artifact 卡片，而不是两个都追加进去。
  function appendArtifact(id: string, name: string, mimeType: string, size: number) {
    setBlocks((prev) => {
      const last = lastOf(prev)
      const artifactBlock: Block = { kind: 'artifact', id, name, mimeType, size }
      if (last?.kind === 'tool' && last.status === 'running') {
        return [...prev.slice(0, -1), artifactBlock]
      }
      return [...prev, artifactBlock]
    })
  }

  function adoptSessionId(id: string) {
    setActiveSessionId(id)
  }

  function handleNewSession() {
    if (running) return
    setActiveSessionId(undefined)
    setBlocks([])
    setMessagesLoading(false)
  }

  async function loadSession(id: string) {
    if (running || id === sessionId) return
    setActiveSessionId(id)
    setBlocks([])
    setMessagesLoading(true)
    try {
      const messages = await getSessionMessages(id)
      setBlocks(messagesToBlocks(messages))
    } catch (err) {
      appendError(err instanceof Error ? err.message : String(err))
    } finally {
      setMessagesLoading(false)
    }
  }

  async function run(attachments?: UploadedAttachment[]) {
    const currentTask = task.trim()
    if (!currentTask || running) return

    setTask('')
    setBlocks((prev) => [...prev, { kind: 'user', text: currentTask, attachments }])
    setRunning(true)
    try {
      for await (const event of runAgent(currentTask, sessionId, attachments)) {
        switch (event.type) {
          case 'session':
            adoptSessionId(event.sessionId)
            break
          case 'text_delta':
            appendText(event.delta)
            break
          case 'tool_call':
            startTool(event.id, event.name, event.args)
            break
          case 'tool_result':
            finishTool(event.id, event.result)
            break
          case 'document':
            appendDocument(event.name, event.content)
            break
          case 'artifact':
            appendArtifact(event.id, event.name, event.mimeType, event.size)
            break
          case 'error':
            appendError(event.message)
            break
          case 'done':
            break
        }
      }
    } catch (err) {
      appendError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
      refreshSessions()
    }
  }

  return {
    task,
    setTask,
    blocks,
    running,
    sessionId,
    sessions,
    sessionsLoading,
    messagesLoading,
    handleNewSession,
    loadSession,
    run,
  }
}
