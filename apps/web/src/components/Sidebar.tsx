import { useRef, useState } from 'react'
import { useDebounceFn } from 'ahooks'
import { Check, Loader2, MessagesSquare, Pencil, Plus, Search, Trash2, X } from 'lucide-react'
import { MAX_SESSION_NAME_LENGTH } from '@autonoma/shared'
import { Button } from '@autonoma/ui/components/button'
import { Input } from '@autonoma/ui/components/input'
import { cn } from '@autonoma/ui/lib/utils'
import { AccountMenu } from '@/components/AccountMenu'
import { BrandMark } from '@/components/BrandMark'
import { ConfirmDeleteSessionDialog } from '@/components/ConfirmDeleteSessionDialog'
import { formatRelativeTime } from '@/lib/format'
import { useConsoleStore } from '@/store/consoleStore'

// 使用不同的宽度，让骨架屏看起来像占位文字，
// 而不是一堆宽度可疑地整齐划一的横条。
const SKELETON_ROWS = [78, 55, 68, 45]

// 搜索输入防抖 300ms 再真正触发请求——避免用户每敲一个字就打一次
// GET /api/sessions，服务端的搜索是直接查数据库的 ILIKE，不是本地过滤。
const SEARCH_DEBOUNCE_MS = 300

// 左侧栏：会话列表 + agent 配置。会话列表/当前状态直接从 consoleStore
// 订阅——不再经手 Console 转发的 props，所以流式输出期间（blocks 变化）
// 不会跟着重渲染，只有真正相关的切片（sessions/sessionsLoading/
// sessionId/running）变化时才会。
export function Sidebar({
  collapsed,
  onNewSession,
  onSelectSession,
  onClose,
  username,
  onOpenSettings,
  onLogoutClick,
}: {
  collapsed: boolean
  onNewSession: () => void
  onSelectSession: (id: string) => void
  onClose: () => void
  username: string | undefined
  onOpenSettings: () => void
  onLogoutClick: () => void
}) {
  const sessions = useConsoleStore((s) => s.sessions)
  const sessionsLoading = useConsoleStore((s) => s.sessionsLoading)
  const sessionsHasMore = useConsoleStore((s) => s.sessionsHasMore)
  const sessionsLoadingMore = useConsoleStore((s) => s.sessionsLoadingMore)
  const setSessionSearch = useConsoleStore((s) => s.setSessionSearch)
  const loadMoreSessions = useConsoleStore((s) => s.loadMoreSessions)
  const renameSession = useConsoleStore((s) => s.renameSession)
  const deleteSession = useConsoleStore((s) => s.deleteSession)
  const activeSessionId = useConsoleStore((s) => s.sessionId)
  const disabled = useConsoleStore((s) => s.running)

  const [searchInput, setSearchInput] = useState('')
  // 用 ahooks 的 useDebounceFn 代替手写的 useEffect + setTimeout——
  // 之前那版用 effect 监听 searchInput 变化，组件挂载时 effect 也会跑
  // 一遍（哪怕 searchInput 从没变过），本想拿一个 ref 挡掉首次挂载，
  // 但 React StrictMode 开发模式下同一个 effect 会连续调用两次、ref
  // 在两次调用之间是共享的，第一次调用把 ref 置为 false 之后，第二次
  // 调用就不再被挡住，照样多打一次 GET /api/sessions，跟
  // Console.tsx 的 initialize() 已经拉过的那次重复。
  // useDebounceFn 从根上没有这个问题——它只在 run() 真正被调用时才
  // 防抖（在下面 onChange 里调用），不会在组件挂载阶段被动触发。
  const { run: debouncedSetSessionSearch } = useDebounceFn(
    (value: string) => setSessionSearch(value),
    { wait: SEARCH_DEBOUNCE_MS },
  )

  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  // 打开编辑框时预填的原始文本——可能是显式设置过的 name，也可能只是
  // 自动预览/占位符（session 没有 name 时 label 会 fallback 到
  // s.preview/'新会话'）。commitRename 靠它判断"用户到底有没有改过"。
  const [renameOriginal, setRenameOriginal] = useState('')
  const [renameSaving, setRenameSaving] = useState(false)
  const renameInputRef = useRef<HTMLInputElement>(null)

  function startRename(id: string, currentLabel: string) {
    setRenamingId(id)
    setRenameValue(currentLabel)
    setRenameOriginal(currentLabel)
    // 下一帧再 focus——这一刻 input 还没挂载出来。
    requestAnimationFrame(() => renameInputRef.current?.select())
  }

  async function commitRename(id: string) {
    if (renameSaving) return
    // 没有实际改动就直接关闭编辑框，不发请求——否则未设置过 name、
    // 靠 s.preview 自动带出显示文本的会话，只是打开又原样确认一下，
    // 就会把这段自动预览永久锁成固定 name，之后不再跟着对话内容更新。
    if (renameValue.trim() === renameOriginal.trim()) {
      setRenamingId(null)
      return
    }
    setRenameSaving(true)
    const ok = await renameSession(id, renameValue)
    setRenameSaving(false)
    if (ok) setRenamingId(null)
    // 失败时留在编辑态，方便重试——错误提示由 consoleStore 内部走
    // appendError 冒泡到对话区，这里不重复展示。
  }

  const [deleteTarget, setDeleteTarget] = useState<{ id: string; label: string } | null>(null)

  // 与下方抽屉/面板过渡动画相同的 “expo out” 曲线，这样背景遮罩的
  // 淡入淡出和侧边栏的滑动能保持同步，而不会出现一方明显滞后于另一方。
  const EASE = 'ease-[cubic-bezier(0.16,1,0.3,1)]'

  return (
    <>
      {/* 在小于 `md` 的屏幕上，侧边栏是覆盖在控制台上方的，而不是把它挤压
          成一条窄缝——这个背景遮罩就是让点击外部区域可以关闭侧边栏的原因，
          和其他移动端抽屉的行为一致。始终挂载（而不是条件渲染），
          这样退场时也能播放淡出动画，而不是 `collapsed` 一变就瞬间消失。 */}
      <div
        aria-hidden
        onClick={onClose}
        className={cn(
          `fixed inset-0 z-30 bg-black/40 transition-opacity duration-300 md:hidden ${EASE}`,
          collapsed ? 'pointer-events-none opacity-0' : 'opacity-100',
        )}
      />
      <aside
        className={cn(
          `flex shrink-0 flex-col overflow-hidden border-r bg-sidebar text-sidebar-foreground transition-transform duration-300 ${EASE}`,
          // 移动端：固定定位的抽屉，滑入滑出（宽度保持不变，
          // 这样下方内容不会被重排）。
          'fixed inset-y-0 left-0 z-40 w-64 max-w-[80vw]',
          collapsed ? '-translate-x-full' : 'translate-x-0',
          // 桌面端（md 及以上）：回到文档流内的面板，宽度变化会
          // 推动控制台区域，而不是覆盖在它上面。
          `md:static md:z-auto md:translate-x-0 md:transition-[width] md:duration-300 ${EASE}`,
          collapsed ? 'md:w-0 md:border-r-0' : 'md:w-64',
        )}
      >
        <div className="flex items-center gap-2 px-4 py-3.5">
          <BrandMark className="size-7 shrink-0" />
          <span className="font-semibold whitespace-nowrap">Autonoma</span>
        </div>

        <div className="space-y-2 px-3">
          <Button
            variant="outline"
            className="w-full justify-start gap-2 text-sidebar-foreground transition-shadow hover:shadow-[0_4px_16px_-8px_color-mix(in_oklch,var(--primary)_45%,transparent)]"
            onClick={onNewSession}
            disabled={disabled}
          >
            <Plus className="size-4" />
            新建会话
          </Button>

          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-sidebar-foreground/40" />
            <Input
              value={searchInput}
              onChange={(e) => {
                // 输入框本身的回显不等防抖——用户敲键盘要立刻看到自己
                // 打的字，防抖只用来控制"什么时候真正去请求"。
                setSearchInput(e.target.value)
                debouncedSetSessionSearch(e.target.value)
              }}
              placeholder="搜索会话"
              className="h-8 border-sidebar-border bg-sidebar-accent/30 pl-8 text-sm text-sidebar-foreground placeholder:text-sidebar-foreground/40"
            />
          </div>
        </div>

        <div className="mt-3 flex-1 overflow-y-auto px-3">
          <p className="px-1 text-xs font-medium text-sidebar-foreground/50">会话</p>
          {sessionsLoading ? (
            <div className="mt-2 space-y-1">
              {SKELETON_ROWS.map((width, i) => (
                <div
                  key={i}
                  className="animate-pulse space-y-1.5 rounded-lg px-2.5 py-2"
                  style={{ animationDelay: `${i * 120}ms` }}
                >
                  <div className="h-3 rounded-full bg-sidebar-foreground/10" style={{ width: `${width}%` }} />
                  <div className="h-2.5 w-1/3 rounded-full bg-sidebar-foreground/10" />
                </div>
              ))}
            </div>
          ) : sessions.length === 0 ? (
            <div className="relative mt-2 flex flex-col items-center gap-3 overflow-hidden px-3 py-9 text-center">
              <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="h-28 w-28 rounded-full bg-[radial-gradient(circle,color-mix(in_oklch,var(--primary)_18%,transparent)_0%,transparent_70%)] blur-xl" />
              </div>
              <div className="relative flex size-10 items-center justify-center rounded-full bg-gradient-to-br from-primary/15 to-chart-2/15 text-primary">
                <MessagesSquare className="size-4" />
              </div>
              <div className="relative space-y-1">
                <p className="text-xs font-medium text-sidebar-foreground/70">
                  {searchInput ? '没有匹配的会话' : '还没有会话'}
                </p>
                {!searchInput && (
                  <p className="text-[11px] leading-relaxed text-sidebar-foreground/40">
                    新建一个会话，
                    <br />
                    开始你的第一次对话
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="mt-2 space-y-0.5">
              {sessions.map((s) => {
                const label = s.name || s.preview || '新会话'
                const isRenaming = renamingId === s.id
                return (
                  <div key={s.id} className="group/row relative">
                    {isRenaming ? (
                      <div className="flex items-center gap-1 rounded-lg bg-sidebar-accent px-2 py-1.5">
                        <Input
                          ref={renameInputRef}
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitRename(s.id)
                            if (e.key === 'Escape') setRenamingId(null)
                          }}
                          disabled={renameSaving}
                          maxLength={MAX_SESSION_NAME_LENGTH}
                          className="h-7 flex-1 border-transparent bg-transparent px-1.5 text-sm text-sidebar-accent-foreground focus-visible:border-ring"
                        />
                        <button
                          type="button"
                          onClick={() => commitRename(s.id)}
                          disabled={renameSaving}
                          aria-label="保存标题"
                          className="flex size-6 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/60 hover:bg-sidebar-accent-foreground/10 hover:text-sidebar-foreground disabled:opacity-50"
                        >
                          {renameSaving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                        </button>
                        <button
                          type="button"
                          onClick={() => setRenamingId(null)}
                          disabled={renameSaving}
                          aria-label="取消重命名"
                          className="flex size-6 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/60 hover:bg-sidebar-accent-foreground/10 hover:text-sidebar-foreground disabled:opacity-50"
                        >
                          <X className="size-3.5" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() => onSelectSession(s.id)}
                          className={cn(
                            'w-full rounded-lg py-2 pr-14 pl-2.5 text-left outline-none transition-[background-color,color,transform] duration-150 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-sidebar-ring/50 disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100',
                            s.id === activeSessionId
                              ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                              : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/50',
                          )}
                        >
                          <div className="truncate text-sm">{label}</div>
                          <div className="text-[11px] text-sidebar-foreground/40">{formatRelativeTime(s.updatedAt)}</div>
                        </button>
                        {/* 桌面端（md 及以上）默认不可见也不可点——鼠标悬停/键盘聚焦
                            到这一行时才淡入并恢复可点击，跟 ToolCard 的展开按钮同一个
                            思路：默认不占视觉噪音，需要时又不用专门去找。opacity 和
                            pointer-events 必须一起切换，否则隐藏状态下这块区域仍会
                            拦截本该落在下面"选中会话"按钮上的点击。移动端没有 hover，
                            触屏用户始终能看到、也始终可点。 */}
                        <div className="absolute top-1/2 right-1.5 flex -translate-y-1/2 gap-0.5 opacity-100 transition-opacity md:opacity-0 md:group-hover/row:opacity-100 md:group-focus-within/row:opacity-100">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              startRename(s.id, label)
                            }}
                            disabled={disabled}
                            aria-label={`重命名「${label}」`}
                            className="flex size-6 items-center justify-center rounded-md text-sidebar-foreground/50 hover:bg-sidebar-accent-foreground/10 hover:text-sidebar-foreground disabled:opacity-50"
                          >
                            <Pencil className="size-3" />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              setDeleteTarget({ id: s.id, label })
                            }}
                            disabled={disabled}
                            aria-label={`删除「${label}」`}
                            className="flex size-6 items-center justify-center rounded-md text-sidebar-foreground/50 hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                          >
                            <Trash2 className="size-3" />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )
              })}
              {sessionsHasMore && (
                <button
                  type="button"
                  onClick={() => loadMoreSessions()}
                  disabled={sessionsLoadingMore}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg px-2.5 py-2 text-xs text-sidebar-foreground/50 transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground/80 disabled:pointer-events-none"
                >
                  {sessionsLoadingMore ? (
                    <>
                      <Loader2 className="size-3 animate-spin" />
                      加载中…
                    </>
                  ) : (
                    '加载更多'
                  )}
                </button>
              )}
            </div>
          )}
        </div>

        <AccountMenu username={username} onOpenSettings={onOpenSettings} onLogoutClick={onLogoutClick} />
      </aside>

      <ConfirmDeleteSessionDialog
        target={deleteTarget}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={async (id) => {
          const ok = await deleteSession(id)
          if (ok) setDeleteTarget(null)
          return ok
        }}
      />
    </>
  )
}
