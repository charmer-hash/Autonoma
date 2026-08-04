import { create } from 'zustand'
import { last as lastOf } from 'lodash-es'
import type { SessionSummary, UploadedAttachment } from '@autonoma/shared'
import type { Block, SentAttachment } from '@/types/blocks'
import { postApprovalDecision, runAgent } from '@/lib/agent-api'
import { getSessionMessages, listSessions } from '@/lib/sessions-api'
import { messagesToBlocks } from '@/lib/blocks'
import { readSessionIdFromUrl, syncSessionIdToUrl } from '@/lib/session-url'
import { usePanelStore } from './panelStore'

const SESSION_ID_STORAGE_KEY = 'sessionId'

function readStoredSessionId(): string | undefined {
  return localStorage.getItem(SESSION_ID_STORAGE_KEY) ?? undefined
}

function writeStoredSessionId(id: string | undefined) {
  if (id) localStorage.setItem(SESSION_ID_STORAGE_KEY, id)
  else localStorage.removeItem(SESSION_ID_STORAGE_KEY)
}

// sessionId 由服务端签发，客户端从不自行选取（见 apps/server/src/index.ts）。
// 同时保存在 URL 的 ?session= 参数中（这样一段对话可以被收藏/分享后直接
// 重新打开）以及 localStorage 中（这样即使没有该参数的普通刷新也能继续
// 上一次的对话）。两者都存在时以 URL 为准。
const initialSessionId = readSessionIdFromUrl() ?? readStoredSessionId()

interface ConsoleStore {
  task: string
  blocks: Block[]
  running: boolean
  sessionId: string | undefined
  sessions: SessionSummary[]
  sessionsLoading: boolean
  messagesLoading: boolean

  setTask: (task: string) => void
  // 在 Console.tsx 挂载时调用一次——拉会话列表、如果有待恢复的
  // sessionId 就把它的历史消息也拉回来。
  initialize: () => void
  refreshSessions: () => Promise<void>
  handleNewSession: () => void
  loadSession: (id: string) => Promise<void>
  run: (attachments?: SentAttachment[]) => Promise<void>
  // 审批模式下点击工具卡片的批准/拒绝按钮时调用（见 ToolCard.tsx）——
  // 真正的状态变化仍由后续从同一条 SSE 连接推来的 tool_call/tool_result
  // 事件驱动，这里只负责把决定发给服务端。返回值供调用方判断请求是否
  // 失败，失败时调用方可以把按钮重新启用以便重试。
  respondToApproval: (toolCallId: string, approved: boolean) => Promise<boolean>
  // 登出时调用——不止清掉 sessionId，会话列表/当前对话内容也要一并
  // 清空，否则这个 store 是模块级单例，不会随 Console 卸载/重新
  // 挂载自动重置，换账号登录后会看到上一个账号残留的数据。
  reset: () => void
}

export const useConsoleStore = create<ConsoleStore>((set, get) => {
  function setActiveSessionId(id: string | undefined) {
    writeStoredSessionId(id)
    syncSessionIdToUrl(id)
    set({ sessionId: id })
  }

  function appendText(delta: string) {
    set((s) => {
      const last = lastOf(s.blocks)
      if (last?.kind === 'text') {
        return { blocks: [...s.blocks.slice(0, -1), { kind: 'text', text: last.text + delta }] }
      }
      return { blocks: [...s.blocks, { kind: 'text', text: delta }] }
    })
  }

  // 审批模式（settings.approvalMode === 'confirm'）下，run_command/write_file/
  // export_artifact 这几个工具会先发一个 approval_required 事件把 block 建成
  // 'awaiting_approval'（见下面的 requestApproval）；用户批准后，服务端会为
  // 同一个 tool_call id 重新发一次 tool_call 事件（见 agent/loop.ts）——这里
  // 必须原地把已存在的 block 转成 'running'，而不是无条件 push 一个新的，
  // 否则同一次调用会在列表里出现两张卡片。
  function startTool(id: string, name: string, args: unknown) {
    set((s) => {
      const idx = s.blocks.findIndex((b) => b.kind === 'tool' && b.id === id)
      if (idx !== -1) {
        return {
          blocks: [
            ...s.blocks.slice(0, idx),
            { ...(s.blocks[idx] as Extract<Block, { kind: 'tool' }>), args, status: 'running' },
            ...s.blocks.slice(idx + 1),
          ],
        }
      }
      return { blocks: [...s.blocks, { kind: 'tool', id, name, args, status: 'running' }] }
    })
    // 工具调用一开始就自动打开右侧面板，这样观察 agent 工作不需要点击
    // 任何东西——放在这里（而不是 Console.tsx 里监听 blocks 变化的
    // useEffect）是因为这正是"一个新工具调用开始"这件事发生的唯一
    // 地方，不需要再额外用 ref 记录"上次是不是已经为这个 id 触发过"。
    usePanelStore.getState().autoOpen({ kind: 'tool', id })
  }

  // 审批门控的工具调用真正执行前先停在这里，等用户在 ToolCard 上点批准/
  // 拒绝——拒绝或超时会直接收到 tool_result（finishTool 按 id 匹配即可
  // 正常处理），批准会收到重复的 tool_call（上面 startTool 已处理原地转换）。
  function requestApproval(id: string, name: string, args: unknown) {
    set((s) => ({ blocks: [...s.blocks, { kind: 'tool', id, name, args, status: 'awaiting_approval' }] }))
    usePanelStore.getState().autoOpen({ kind: 'tool', id })
  }

  // 按 id 匹配，而不是"最后一个 block"——SSE 的 tool_call/tool_result
  // 事件携带着与对应 tool_call 相同的 id，所以即使关于顺序的假设以后
  // 发生变化，这里依然是正确的。
  function finishTool(id: string, result: string) {
    set((s) => {
      const idx = s.blocks.findIndex((b) => b.kind === 'tool' && b.id === id)
      if (idx === -1) return s
      return {
        blocks: [
          ...s.blocks.slice(0, idx),
          { ...(s.blocks[idx] as Extract<Block, { kind: 'tool' }>), result, status: 'done' },
          ...s.blocks.slice(idx + 1),
        ],
      }
    })
  }

  function appendError(text: string) {
    set((s) => ({ blocks: [...s.blocks, { kind: 'error', text }] }))
  }

  function appendDocument(name: string, content: string) {
    set((s) => ({ blocks: [...s.blocks, { kind: 'document', name, content }] }))
  }

  // export_artifact 总是先发出一个运行中的工具卡片（见 loop.ts），所以
  // 这里是把那个卡片替换成 artifact 卡片，而不是两个都追加进去。
  function appendArtifact(id: string, name: string, mimeType: string, size: number) {
    set((s) => {
      const last = lastOf(s.blocks)
      const artifactBlock: Block = { kind: 'artifact', id, name, mimeType, size }
      if (last?.kind === 'tool' && last.status === 'running') {
        return { blocks: [...s.blocks.slice(0, -1), artifactBlock] }
      }
      return { blocks: [...s.blocks, artifactBlock] }
    })
  }

  return {
    task: '',
    blocks: [],
    running: false,
    sessionId: initialSessionId,
    sessions: [],
    sessionsLoading: true,
    // 只要存在待恢复的 sessionId，初始值就为 true，这样控制台会显示
    // 加载状态，而不是对一个实际上有历史记录的会话短暂闪现"暂无消息"
    // 的空状态。
    messagesLoading: Boolean(initialSessionId),

    setTask: (task) => set({ task }),

    refreshSessions: async () => {
      try {
        set({ sessions: await listSessions() })
      } catch (err) {
        console.error('failed to load sessions:', err)
      } finally {
        set({ sessionsLoading: false })
      }
    },

    // 在页面刷新时恢复对话——sessionId 保存在 localStorage/URL 中得以
    // 留存，但 blocks 不会保留，所以如果没有这段逻辑，刷新会显示空的
    // 控制台，尽管服务端仍保留着历史记录。
    initialize: () => {
      get().refreshSessions()
      const { sessionId } = get()
      // 如果 sessionId 只是来自 localStorage 兜底（URL 中还没有
      // ?session=），也把它同步到 URL 中，使其能立即被分享。
      if (sessionId && readSessionIdFromUrl() !== sessionId) {
        syncSessionIdToUrl(sessionId)
      }
      if (sessionId) {
        getSessionMessages(sessionId)
          .then((messages) => set({ blocks: messagesToBlocks(messages) }))
          .catch((err) => appendError(err instanceof Error ? err.message : String(err)))
          .finally(() => set({ messagesLoading: false }))
      }
    },

    handleNewSession: () => {
      if (get().running) return
      setActiveSessionId(undefined)
      set({ blocks: [], messagesLoading: false })
    },

    loadSession: async (id) => {
      if (get().running || id === get().sessionId) return
      setActiveSessionId(id)
      set({ blocks: [], messagesLoading: true })
      try {
        const messages = await getSessionMessages(id)
        set({ blocks: messagesToBlocks(messages) })
      } catch (err) {
        appendError(err instanceof Error ? err.message : String(err))
      } finally {
        set({ messagesLoading: false })
      }
    },

    run: async (attachments) => {
      const currentTask = get().task.trim()
      if (!currentTask || get().running) return

      set((s) => ({
        task: '',
        blocks: [...s.blocks, { kind: 'user', text: currentTask, attachments }],
        running: true,
      }))
      // 新的一轮对话重新获得自动打开面板的机会，即使用户在上一轮进行到
      // 一半时关闭了它。
      usePanelStore.getState().resetAutoOpen()

      // previewUrl 是浏览器本地的 blob: URL，只用来让刚发送的这条本地
      // 消息立刻显示缩略图（见 Composer.tsx）——服务端不需要也不认得
      // 这个字段。
      const wireAttachments: UploadedAttachment[] | undefined = attachments?.map(
        ({ previewUrl: _previewUrl, ...rest }) => rest,
      )
      try {
        for await (const event of runAgent(currentTask, get().sessionId, wireAttachments)) {
          switch (event.type) {
            case 'session':
              setActiveSessionId(event.sessionId)
              break
            case 'text_delta':
              appendText(event.delta)
              break
            case 'tool_call':
              startTool(event.id, event.name, event.args)
              break
            case 'approval_required':
              requestApproval(event.id, event.name, event.args)
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
        set({ running: false })
        get().refreshSessions()
      }
    },

    respondToApproval: async (toolCallId, approved) => {
      const sessionId = get().sessionId
      if (!sessionId) return false
      try {
        await postApprovalDecision(sessionId, toolCallId, approved)
        return true
      } catch (err) {
        appendError(err instanceof Error ? err.message : String(err))
        return false
      }
    },

    reset: () => {
      writeStoredSessionId(undefined)
      syncSessionIdToUrl(undefined)
      set({
        task: '',
        blocks: [],
        running: false,
        sessionId: undefined,
        sessions: [],
        sessionsLoading: true,
        messagesLoading: false,
      })
    },
  }
})
