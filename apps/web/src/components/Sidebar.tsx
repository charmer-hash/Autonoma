import { MessagesSquare, Plus, Settings } from 'lucide-react'
import type { SessionSummary } from '@autonoma/shared'
import { Button } from '@autonoma/ui/components/button'
import { cn } from '@autonoma/ui/lib/utils'
import { BrandMark } from '@/components/BrandMark'
import { formatRelativeTime } from '@/lib/format'

// 使用不同的宽度，让骨架屏看起来像占位文字，
// 而不是一堆宽度可疑地整齐划一的横条。
const SKELETON_ROWS = [78, 55, 68, 45]

// 左侧栏：会话列表 + agent 配置。
export function Sidebar({
  collapsed,
  sessions,
  sessionsLoading,
  activeSessionId,
  disabled,
  onNewSession,
  onSelectSession,
  onClose,
}: {
  collapsed: boolean
  sessions: SessionSummary[]
  sessionsLoading: boolean
  activeSessionId: string | undefined
  disabled: boolean
  onNewSession: () => void
  onSelectSession: (id: string) => void
  onClose: () => void
}) {
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

        <div className="px-3">
          <Button
            variant="outline"
            className="w-full justify-start gap-2 text-sidebar-foreground shadow-[0_1px_0_0_rgba(255,255,255,0.4)_inset] transition-shadow hover:shadow-[0_4px_16px_-8px_color-mix(in_oklch,var(--primary)_45%,transparent)]"
            onClick={onNewSession}
            disabled={disabled}
          >
            <Plus className="size-4" />
            新建会话
          </Button>
        </div>

        <div className="mt-4 flex-1 overflow-y-auto px-3">
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
                <p className="text-xs font-medium text-sidebar-foreground/70">还没有会话</p>
                <p className="text-[11px] leading-relaxed text-sidebar-foreground/40">
                  新建一个会话，
                  <br />
                  开始你的第一次对话
                </p>
              </div>
            </div>
          ) : (
            <div className="mt-2 space-y-0.5">
              {sessions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => onSelectSession(s.id)}
                  className={cn(
                    'w-full rounded-lg px-2.5 py-2 text-left transition-[background-color,color,transform] duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100',
                    s.id === activeSessionId
                      ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                      : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/50',
                  )}
                >
                  <div className="truncate text-sm">{s.preview || '新会话'}</div>
                  <div className="text-[11px] text-sidebar-foreground/40">{formatRelativeTime(s.updatedAt)}</div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="border-t px-3 py-3">
          <Button
            variant="ghost"
            className="w-full justify-start gap-2 text-sidebar-foreground/70"
            disabled
            title="即将上线"
          >
            <Settings className="size-4" />
            Agent 设置
          </Button>
        </div>
      </aside>
    </>
  )
}
