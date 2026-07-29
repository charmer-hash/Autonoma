import { History, Plus, Settings } from 'lucide-react'
import type { SessionSummary } from '@autonoma/shared'
import { Button } from '@autonoma/ui/components/button'
import { cn } from '@autonoma/ui/lib/utils'
import { BrandMark } from '@/components/BrandMark'
import { formatRelativeTime } from '@/lib/format'

// Left rail: session list + agent config.
export function Sidebar({
  collapsed,
  sessions,
  activeSessionId,
  disabled,
  onNewSession,
  onSelectSession,
}: {
  collapsed: boolean
  sessions: SessionSummary[]
  activeSessionId: string | undefined
  disabled: boolean
  onNewSession: () => void
  onSelectSession: (id: string) => void
}) {
  return (
    <aside
      className={
        'flex shrink-0 flex-col overflow-hidden border-r bg-sidebar text-sidebar-foreground transition-[width] duration-200 ' +
        (collapsed ? 'w-0 border-r-0' : 'w-64')
      }
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
        {sessions.length === 0 ? (
          <div className="mt-2 flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-sidebar-border px-3 py-6 text-center">
            <History className="size-4 text-sidebar-foreground/30" />
            <p className="text-xs text-sidebar-foreground/40">还没有会话历史</p>
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
                  'w-full rounded-lg px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50',
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
  )
}
