import { create } from 'zustand'
import { last as lastOf } from 'lodash-es'
import type { AgentEvent, SessionSummary, UploadedAttachment } from '@autonoma/shared'
import type { Block, SentAttachment } from '@/types/blocks'
import { NoActiveRunError, StreamDroppedError, postApprovalDecision, reconnectAgent, runAgent } from '@/lib/agent-api'
import {
  deleteSession as deleteSessionApi,
  getSessionMessageCount,
  getSessionMessages,
  listSessions,
  renameSession as renameSessionApi,
} from '@/lib/sessions-api'
import { messagesToBlocks } from '@/lib/blocks'
import { readSessionIdFromUrl, syncSessionIdToUrl } from '@/lib/session-url'
import { usePanelStore } from './panelStore'

const SESSIONS_PAGE_SIZE = 50

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// SSE 连接断线后的重连退避序列——服务端本来就会把这一轮跑完并落库
// （见 agent-api.ts 顶部注释），这里只是尽量把过程和结果实时续上。
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 10000]
// 重连也没能续上（比如缓冲区已经过了宽限期）时的最后一层兜底——
// 定期整体重新拉取持久化历史，直到看到这一轮的新内容落库为止。
const POLL_INTERVAL_MS = 3000
const POLL_MAX_ATTEMPTS = 15

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
  // 分页/搜索状态——refreshSessions 永远重置到第一页（用于初始加载、
  // 搜索词变化、一轮对话结束后把刚活跃的会话顶到最前面这几种场景），
  // loadMoreSessions 在此基础上追加下一页。
  sessionsHasMore: boolean
  sessionsLoadingMore: boolean
  sessionSearch: string
  messagesLoading: boolean

  setTask: (task: string) => void
  // 在 Console.tsx 挂载时调用一次——拉会话列表、如果有待恢复的
  // sessionId 就把它的历史消息也拉回来。
  initialize: () => void
  // preserveLoadedCount: 已经翻过页时（比如看到了 150 条里的第 2/3 页），
  // 一轮对话结束后不该把列表悄悄收回到只剩第一页——按当前已加载的条数
  // 重新拉，而不是固定拉一页。搜索词变化/初始加载仍然传 false（默认），
  // 这两种场景本来就该看到"当前条件下最新的第一页"。
  refreshSessions: (opts?: { preserveLoadedCount?: boolean }) => Promise<void>
  loadMoreSessions: () => Promise<void>
  setSessionSearch: (search: string) => void
  renameSession: (id: string, name: string | null) => Promise<boolean>
  deleteSession: (id: string) => Promise<boolean>
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
  // refreshSessions 会在搜索词快速变化、一轮对话结束、初始加载等场景
  // 被连续调用多次，请求本身不保证按发出顺序返回——用一个自增序号在
  // 响应落地时判断"我还是不是最新的那一次请求"，不是就丢弃结果，避免
  // 旧请求的响应在新请求之后才到达、把已经展示的新结果重新覆盖回旧的。
  let refreshSessionsSeq = 0

  // run() 发起断线重连/轮询兜底（recoverAfterDrop/pollUntilSettled）之后，
  // 这条 Promise 链可能会跑好几秒到几十秒——期间用户如果点了"退出登录"，
  // reset() 会清空 sessionId/blocks，但没有任何机制能中断这条已经在跑的
  // 链，它后续 resolve 时还是会照常往（已经清空过的）全局 store 里写数据，
  // 换了新账号登录后这些内容甚至会串到新账号的会话里。用一个自增的
  // "代次"计数器解决：run() 一开始记下当时的代次，之后每次要往 store 写
  // 东西之前都先确认代次没变；reset() 会让代次前进一格，让所有仍在跑的
  // 旧代次直接失效——网络请求本身不会被中止（避免为此再去改
  // agent-api.ts 的 SSE 读取逻辑），但它的结果不会再被应用到 store 上。
  let runEpoch = 0

  function setActiveSessionId(id: string | undefined) {
    writeStoredSessionId(id)
    syncSessionIdToUrl(id)
    set({ sessionId: id })
  }

  // 刚发送出去的图片附件用的是本地 blob: URL（见 Composer.tsx 的
  // URL.createObjectURL），只要这条消息还显示在 blocks 里就得保持有效。
  // 一旦 blocks 要被整体替换/清空（切会话、新建会话、删除当前会话、
  // 登出、或断线恢复兜底时用持久化历史整体覆盖），这些 URL 就再也不会
  // 被引用到了——在丢弃旧 blocks 之前调用这个函数释放它们，否则这部分
  // 内存会随着用户发的图片越来越多、且从不主动切换/刷新页面而无限增长
  // （浏览器不会自己知道该回收，因为 blob: URL 本身就是刻意保活到
  // revokeObjectURL 被调用为止）。
  function revokeAttachmentPreviewUrls(blocks: Block[]) {
    for (const block of blocks) {
      if (block.kind !== 'user') continue
      for (const attachment of block.attachments ?? []) {
        if (attachment.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(attachment.previewUrl)
      }
    }
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

  // run() 的正常消费路径和断线重连后的续传路径共用同一份事件处理逻辑，
  // 避免维护两份重复的 switch。
  function applyEvent(event: AgentEvent) {
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

  // 重连也没能续上时的最后一层兜底——反复整体拉取持久化历史，直到看到
  // 这一轮的新内容已经落库（消息数超过 referenceCount，即这一轮任务提交
  // 之前的数据库状态——由调用方在 run() 一开始就先取好，见下面 run() 里
  // 的 beforeCountPromise）。在此之前故意不碰 blocks：runAgentLoop 只在
  // 整轮结束时才一次性落库（见 apps/server/src/index.ts 的
  // appendMessages），过早用旧历史整体替换 blocks 只会让用户刚发的这条
  // 消息和已经收到的进度突然从界面上消失，之后又重新出现。
  async function pollUntilSettled(sessionId: string, referenceCount: number, epoch: number): Promise<boolean> {
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      await sleep(POLL_INTERVAL_MS)
      // 代次已经变了（比如登出了）——不再是当初发起这次恢复时的那个
      // "现在"，停止轮询，也不再写任何东西回 store。
      if (epoch !== runEpoch) return false
      try {
        const messages = await getSessionMessages(sessionId)
        if (epoch !== runEpoch) return false
        if (messages.length > referenceCount) {
          revokeAttachmentPreviewUrls(get().blocks)
          set({ blocks: messagesToBlocks(messages) })
          return true
        }
      } catch {
        // 轮询期间的瞬时失败不放弃，继续重试到耗尽为止。
      }
    }
    return false
  }

  // SSE 连接中途断开时调用（见 run() 里对 StreamDroppedError 的捕获）。
  // 服务端这一轮运行本身不受断线影响、会继续跑完并落库（见
  // apps/web/src/lib/agent-api.ts 顶部注释），这里只负责尽量把过程和
  // 结果续回来：先按退避序列重连,续不上再退化成轮询兜底。
  //
  // beforeCount 必须是"这一轮任务提交之前"的消息数（由 run() 在最开始、
  // 断线发生之前就取好），不能在这里（检测到断线的这一刻）才现取——如果
  // 断线发生后很久才被发现并触发恢复（比如设备长时间休眠后唤醒），这一轮
  // 其实早就跑完并落库了，此时现取的基准会已经包含这一轮的结果，导致
  // pollUntilSettled 的"数量超过基准"这个条件永远无法满足。
  async function recoverAfterDrop(
    initialSeq: number,
    initialRunId: string | undefined,
    beforeCount: number,
    epoch: number,
  ): Promise<void> {
    if (epoch !== runEpoch) return
    const sessionId = get().sessionId
    if (!sessionId) {
      // 断线发生在还没收到过 session 事件的全新会话上——客户端连
      // sessionId 都不知道，没有任何东西可以拿来重连或轮询。
      appendError('连接已断开，且当前对话尚未建立，请重新发送。')
      return
    }

    appendError('连接已断开，正在尝试恢复…')

    let seq = initialSeq
    // runId 理论上不会在重试过程中变化——它标识的是断线前那一条正在跑的
    // run，重连请求要一直问的都是同一条。如果服务端连一个事件都还没发出
    // 就断线了（比如极端网络抖动），initialRunId 会是 undefined，这时候
    // 根本没有 runId 可以拿去重连，直接跳过重连、退化成轮询兜底。
    if (initialRunId) {
      const runId = initialRunId
      for (const delay of RECONNECT_DELAYS_MS) {
        await sleep(delay)
        // 等待退避延迟期间代次可能已经变了（比如这段时间用户点了退出
        // 登录）——不再尝试重连，也不再写任何东西回 store。
        if (epoch !== runEpoch) return
        try {
          for await (const frame of reconnectAgent(sessionId, runId, seq)) {
            if (epoch !== runEpoch) return
            seq = frame.seq
            applyEvent(frame.event)
          }
          return
        } catch (err) {
          if (epoch !== runEpoch) return
          if (err instanceof StreamDroppedError) {
            seq = err.lastSeq
            continue
          }
          if (err instanceof NoActiveRunError) break
          appendError(err instanceof Error ? err.message : String(err))
          return
        }
      }
    }

    if (epoch !== runEpoch) return
    const settled = await pollUntilSettled(sessionId, beforeCount, epoch)
    if (!settled && epoch === runEpoch) {
      appendError('连接中断且未能确认任务是否完成，请查看最新记录，如未完成请重新发送。')
    }
  }

  return {
    task: '',
    blocks: [],
    running: false,
    sessionId: initialSessionId,
    sessions: [],
    sessionsLoading: true,
    sessionsHasMore: false,
    sessionsLoadingMore: false,
    sessionSearch: '',
    // 只要存在待恢复的 sessionId，初始值就为 true，这样控制台会显示
    // 加载状态，而不是对一个实际上有历史记录的会话短暂闪现"暂无消息"
    // 的空状态。
    messagesLoading: Boolean(initialSessionId),

    setTask: (task) => set({ task }),

    // 默认重置回第一页——搜索词变化、初始加载都要看到"当前条件下最新的
    // 第一页"。一轮对话结束后调用时会传 preserveLoadedCount: true，按
    // 已加载的条数重新拉，避免已经翻到后面几页的用户被无声收回第一页。
    refreshSessions: async (opts) => {
      const seq = ++refreshSessionsSeq
      const search = get().sessionSearch
      const limit = opts?.preserveLoadedCount ? Math.max(SESSIONS_PAGE_SIZE, get().sessions.length) : SESSIONS_PAGE_SIZE
      try {
        const { sessions, hasMore } = await listSessions({ limit, search })
        // 这份结果送回来的时候，可能又有更新的一次 refreshSessions 已经
        // 发出去了（比如响应还在路上时用户又敲了下一个字）——如果那次
        // 更新的请求碰巧先落地，这里就不该再用一份更旧的结果把它覆盖掉。
        if (seq !== refreshSessionsSeq) return
        set({ sessions, sessionsHasMore: hasMore })
      } catch (err) {
        console.error('failed to load sessions:', err)
      } finally {
        if (seq === refreshSessionsSeq) set({ sessionsLoading: false })
      }
    },

    loadMoreSessions: async () => {
      if (get().sessionsLoadingMore || !get().sessionsHasMore) return
      set({ sessionsLoadingMore: true })
      try {
        const { sessions: currentSessions, sessionSearch } = get()
        const { sessions: nextPage, hasMore } = await listSessions({
          limit: SESSIONS_PAGE_SIZE,
          offset: currentSessions.length,
          search: sessionSearch,
        })
        set((s) => ({ sessions: [...s.sessions, ...nextPage], sessionsHasMore: hasMore }))
      } catch (err) {
        console.error('failed to load more sessions:', err)
      } finally {
        set({ sessionsLoadingMore: false })
      }
    },

    // 搜索词变化时重新从第一页拉——不在客户端本地过滤已经加载的
    // sessions，因为搜索需要匹配所有会话（包括还没翻到的后续页），
    // 不只是当前已经在内存里的这一小段。
    setSessionSearch: (search) => {
      set({ sessionSearch: search, sessionsLoading: true })
      get().refreshSessions()
    },

    renameSession: async (id, name) => {
      const res = await renameSessionApi(id, name)
      if (!res.ok) {
        appendError(res.error ?? '重命名失败，请重试')
        return false
      }
      // 乐观更新本地列表——不用等下一次 refreshSessions 才能看到新标题。
      // preview 保持不变；name 为空字符串时按服务端的语义视为清除。
      set((s) => ({
        sessions: s.sessions.map((session) => (session.id === id ? { ...session, name: name?.trim() || null } : session)),
      }))
      return true
    },

    deleteSession: async (id) => {
      // 只挡"删的是当前正打开、且有一轮对话在进行中的会话"——运行中的
      // 那次请求结束后还会 appendMessages 一次，如果这时会话行已经被删了
      // 会撞外键。删别的、不相关的会话不受影响，不需要一刀切挡掉所有删除。
      if (get().running && get().sessionId === id) {
        appendError('有对话正在进行，请等它结束后再删除。')
        return false
      }
      const res = await deleteSessionApi(id)
      if (!res.ok) {
        appendError(res.error ?? '删除失败，请重试')
        return false
      }
      set((s) => ({ sessions: s.sessions.filter((session) => session.id !== id) }))
      // 删的是当前正打开的会话——退回到"新会话"状态，不然界面还留着一个
      // 已经不存在于列表里、后续 loadSession 也找不到的会话内容。
      if (get().sessionId === id) {
        setActiveSessionId(undefined)
        revokeAttachmentPreviewUrls(get().blocks)
        set({ blocks: [] })
      }
      return true
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
      revokeAttachmentPreviewUrls(get().blocks)
      set({ blocks: [], messagesLoading: false })
    },

    loadSession: async (id) => {
      if (get().running || id === get().sessionId) return
      setActiveSessionId(id)
      revokeAttachmentPreviewUrls(get().blocks)
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

      // 记下这次运行的代次——reset()（登出）会让 runEpoch 前进一格，
      // 下面每次要往 store 写东西之前都要确认这个代次没变，见上面
      // runEpoch 声明处的注释。
      const myEpoch = ++runEpoch

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

      // 和 runAgent 并发发起,不拖慢正常路径——只有真的走到断线恢复
      // (recoverAfterDrop -> pollUntilSettled)才会用到这个"提交前"的
      // 消息数快照,用来判断轮询到的内容是不是这一轮新产生的。必须在
      // 这里、任务提交之前就取,而不是等检测到断线才现取——理由见
      // recoverAfterDrop 的注释。取不到（新会话还没有 sessionId，或
      // 请求失败）时用 -1,退化成"任何看到的内容都算数"。只要数量、
      // 不要正文——用 getSessionMessageCount 而不是 getSessionMessages，
      // 这条请求发生在每一次发送消息时，没必要为了数一下长度就把可能
      // 很大的消息历史整个传一遍。
      const sessionIdBeforeRun = get().sessionId
      const beforeCountPromise = sessionIdBeforeRun
        ? getSessionMessageCount(sessionIdBeforeRun).catch(() => -1)
        : Promise.resolve(-1)

      try {
        for await (const frame of runAgent(currentTask, get().sessionId, wireAttachments)) {
          if (myEpoch !== runEpoch) return
          applyEvent(frame.event)
        }
      } catch (err) {
        if (myEpoch !== runEpoch) return
        if (err instanceof StreamDroppedError) {
          await recoverAfterDrop(err.lastSeq, err.runId, await beforeCountPromise, myEpoch)
        } else {
          appendError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        // 代次没变才把这次运行标记为结束、刷新会话列表——如果 reset()
        // 已经把代次带走了（登出），running 早就被 reset() 自己重置成
        // false 了，这里不需要（也不应该）再插一脚，更不该在登出之后
        // 还去拉一次会话列表。
        if (myEpoch === runEpoch) {
          set({ running: false })
          get().refreshSessions({ preserveLoadedCount: true })
        }
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
      // 让任何还在跑的 run()/recoverAfterDrop/pollUntilSettled 立刻失效——
      // 它们后续即使还会 resolve，也不会再把结果写回下面这些被清空的字段。
      runEpoch++
      writeStoredSessionId(undefined)
      syncSessionIdToUrl(undefined)
      revokeAttachmentPreviewUrls(get().blocks)
      set({
        task: '',
        blocks: [],
        running: false,
        sessionId: undefined,
        sessions: [],
        sessionsLoading: true,
        sessionsHasMore: false,
        sessionsLoadingMore: false,
        sessionSearch: '',
        messagesLoading: false,
      })
    },
  }
})
