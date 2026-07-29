import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { last as lastOf } from 'lodash-es'
import { gsap } from 'gsap'
import { ArrowUp, Loader2, LogOut, Moon, PanelLeft, Paperclip, Sun, User } from 'lucide-react'
import { Button } from '@autonoma/ui/components/button'
import { Textarea } from '@autonoma/ui/components/textarea'
import { BrandMark } from '@/components/BrandMark'
import { BlockView } from '@/components/BlockView'
import { ConfirmLogoutDialog } from '@/components/ConfirmLogoutDialog'
import { Sidebar } from '@/components/Sidebar'
import { useConsoleSession } from '@/hooks/useConsoleSession'
import { groupBlocks } from '@/lib/blocks'

export function Console({ onLogout }: { onLogout: () => void }) {
  const { task, setTask, blocks, running, sessionId, sessions, handleNewSession, loadSession, run } =
    useConsoleSession()

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false)
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  )
  const bottomRef = useRef<HTMLDivElement>(null)
  const sendButtonRef = useRef<HTMLButtonElement>(null)
  const groupRefs = useRef<(HTMLDivElement | null)[]>([])
  const prevGroupCount = useRef(0)

  const groups = useMemo(() => groupBlocks(blocks), [blocks])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [blocks])

  // Pop in each new message group once, as it first appears — not on every
  // streamed token, since a group's contents keep growing after it's mounted.
  useLayoutEffect(() => {
    if (groups.length > prevGroupCount.current) {
      const el = groupRefs.current[groups.length - 1]
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      if (el && !reduceMotion) {
        gsap.from(el, { opacity: 0, y: 10, duration: 0.35, ease: 'power2.out' })
      }
    }
    prevGroupCount.current = groups.length
  }, [groups.length])

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    document.documentElement.classList.toggle('dark', next === 'dark')
    localStorage.setItem('theme', next)
  }

  function handleRunClick() {
    if (sendButtonRef.current && task.trim() && !running) {
      gsap.fromTo(sendButtonRef.current, { scale: 0.82 }, { scale: 1, duration: 0.35, ease: 'back.out(3)' })
    }
    run()
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleRunClick()
    }
  }

  return (
    <div className="flex h-svh bg-background text-foreground">
      <Sidebar
        collapsed={sidebarCollapsed}
        sessions={sessions}
        activeSessionId={sessionId}
        disabled={running}
        onNewSession={handleNewSession}
        onSelectSession={loadSession}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background/80 px-4 py-3 backdrop-blur">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setSidebarCollapsed((v) => !v)}
            aria-label="切换侧边栏"
          >
            <PanelLeft className="size-4" />
          </Button>
          {sidebarCollapsed && <BrandMark className="size-6 shrink-0" />}
          <span className="text-sm font-medium text-muted-foreground">Agent 控制台</span>
          <div className="ml-auto flex items-center gap-3">
            {running && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="relative flex size-2">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
                  <span className="relative inline-flex size-2 rounded-full bg-primary" />
                </span>
                运行中…
              </span>
            )}
            <Button variant="ghost" size="icon-sm" onClick={toggleTheme} aria-label="切换主题">
              {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setLogoutConfirmOpen(true)}
              aria-label="退出登录"
            >
              <LogOut className="size-4" />
            </Button>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-3 px-6 py-8">
            {blocks.length === 0 && !running && (
              <div className="animate-in fade-in-0 zoom-in-95 relative flex flex-col items-center justify-center gap-3 py-24 text-center text-muted-foreground duration-700">
                <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div className="h-80 w-80 rounded-full bg-[radial-gradient(circle,color-mix(in_oklch,var(--primary)_20%,transparent)_0%,color-mix(in_oklch,var(--chart-2)_12%,transparent)_45%,transparent_72%)] blur-2xl" />
                </div>
                <BrandMark className="relative h-14 w-auto drop-shadow-[0_10px_24px_color-mix(in_oklch,var(--primary)_35%,transparent)]" />
                <p className="relative max-w-sm text-sm">
                  在下方描述一个任务——研究、规划或写代码——Agent 会一步步帮你完成。
                </p>
              </div>
            )}
            {groups.map((group, i) =>
              group.role === 'user' ? (
                <div
                  key={i}
                  ref={(el) => {
                    groupRefs.current[i] = el
                  }}
                  className="flex items-start justify-end gap-2"
                >
                  <div className="max-w-[75%] rounded-2xl bg-primary px-4 py-2 text-sm whitespace-pre-wrap text-primary-foreground">
                    {group.text}
                  </div>
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
                    <User className="size-4" />
                  </div>
                </div>
              ) : (
                <div
                  key={i}
                  ref={(el) => {
                    groupRefs.current[i] = el
                  }}
                  className="flex items-start gap-2"
                >
                  <BrandMark className="size-7 shrink-0" />
                  <div className="min-w-0 flex-1 space-y-2">
                    {group.blocks.map((block, j) => (
                      <BlockView
                        key={j}
                        block={block}
                        live={running && i === groups.length - 1 && j === group.blocks.length - 1}
                      />
                    ))}
                  </div>
                </div>
              ),
            )}
            {running && lastOf(blocks)?.kind === 'user' && (
              <div className="flex items-start gap-2">
                <BrandMark className="size-7 shrink-0 animate-pulse" />
                <div className="flex items-center gap-1 pt-2.5">
                  <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
                  <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
                  <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground" />
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </main>

        <footer className="bg-background px-6 py-4">
          <div className="mx-auto max-w-3xl rounded-2xl border bg-card p-2 shadow-sm transition-shadow duration-300 focus-within:border-primary/40 focus-within:shadow-[0_8px_30px_-14px_color-mix(in_oklch,var(--primary)_45%,transparent)]">
            <Textarea
              value={task}
              onChange={(e) => setTask(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="描述一个任务，例如“计划一次周末旅行”或“写一个打印前 10 个斐波那契数的 Python 脚本，然后运行它”"
              disabled={running}
              rows={1}
              className="max-h-40 resize-none border-0 bg-transparent px-2 shadow-none focus-visible:border-transparent focus-visible:ring-0 disabled:bg-transparent dark:disabled:bg-transparent"
            />
            <div className="flex items-center justify-between px-1 pt-1">
              <Button variant="ghost" size="icon-sm" disabled title="文件上传即将上线">
                <Paperclip className="size-4" />
              </Button>
              <Button
                ref={sendButtonRef}
                size="icon-sm"
                onClick={handleRunClick}
                disabled={running || !task.trim()}
                aria-label="发送"
                className="bg-gradient-to-br from-primary to-chart-2 shadow-[0_6px_20px_-8px_color-mix(in_oklch,var(--primary)_55%,transparent)] transition-shadow hover:opacity-90 hover:shadow-[0_8px_24px_-6px_color-mix(in_oklch,var(--primary)_65%,transparent)]"
              >
                {running ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
              </Button>
            </div>
          </div>
        </footer>
      </div>

      <ConfirmLogoutDialog
        open={logoutConfirmOpen}
        onCancel={() => setLogoutConfirmOpen(false)}
        onConfirm={() => {
          setLogoutConfirmOpen(false)
          onLogout()
        }}
      />
    </div>
  )
}
