import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { gsap } from 'gsap'
import { ChevronsUpDown, LogOut, Settings } from 'lucide-react'
import { cn } from '@autonoma/ui/lib/utils'

// 侧边栏左下角的账号区——合并了原来分散在两处的"Agent 设置"占位按钮
// 和顶部 header 里孤立的退出登录图标按钮，仿照 Notion/Linear/ChatGPT
// 的模式做成一个可展开的账号菜单。
export function AccountMenu({
  username,
  onOpenSettings,
  onLogoutClick,
}: {
  username: string | undefined
  onOpenSettings: () => void
  onLogoutClick: () => void
}) {
  const [open, setOpen] = useState(false)
  const [render, setRender] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (open) setRender(true)
  }, [open])

  useLayoutEffect(() => {
    if (!render || !open) return
    gsap.set(menuRef.current, { opacity: 0, y: 6, scale: 0.97 })
    gsap.to(menuRef.current, { opacity: 1, y: 0, scale: 1, duration: 0.18, ease: 'power3.out' })
  }, [render, open])

  useLayoutEffect(() => {
    if (open || !render) return
    const tl = gsap.timeline({ onComplete: () => setRender(false) })
    tl.to(menuRef.current, { opacity: 0, y: 6, scale: 0.97, duration: 0.12, ease: 'power1.in' })
    return () => {
      tl.kill()
    }
  }, [open, render])

  // 点击菜单容器外部、或按 Esc 都应该收起菜单——这是一个轻量的弹出层，
  // 不是需要显式"取消"按钮的模态框。
  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const displayName = username || '本地账号'
  const initial = displayName.slice(0, 1).toUpperCase()

  return (
    <div ref={containerRef} className="relative border-t px-3 py-3">
      {render && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="账号菜单"
          className="absolute inset-x-3 bottom-full z-10 mb-2 overflow-hidden rounded-xl border bg-popover p-1 text-popover-foreground shadow-[0_16px_40px_-16px_rgba(0,0,0,0.35)]"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onOpenSettings()
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted"
          >
            <Settings className="size-4 text-muted-foreground" />
            Agent 设置
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onLogoutClick()
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-destructive transition-colors hover:bg-destructive/10"
          >
            <LogOut className="size-4" />
            退出登录
          </button>
        </div>
      )}

      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent/50',
          open && 'bg-sidebar-accent/50',
        )}
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary/20 to-chart-2/20 text-xs font-semibold text-primary">
          {initial}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground">{displayName}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-sidebar-foreground/40" />
      </button>
    </div>
  )
}
