import { useLayoutEffect, useRef } from 'react'
import { gsap } from 'gsap'
import { Moon, PanelLeft, Sun } from 'lucide-react'
import { Button } from '@autonoma/ui/components/button'
import { BrandMark } from '@/components/BrandMark'
import { useConsoleStore } from '@/store/consoleStore'

export function ConsoleHeader({
  sidebarCollapsed,
  onToggleSidebar,
  theme,
  onToggleTheme,
}: {
  sidebarCollapsed: boolean
  onToggleSidebar: () => void
  theme: 'light' | 'dark'
  onToggleTheme: () => void
}) {
  const running = useConsoleStore((s) => s.running)
  const themeIconRef = useRef<HTMLSpanElement>(null)
  const mounted = useRef(false)

  // 首次渲染时跳过动画——只在真正切换主题时播放，
  // 否则每次页面刷新都会莫名其妙地转一下图标。
  useLayoutEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduceMotion || !themeIconRef.current) return
    gsap.fromTo(
      themeIconRef.current,
      { rotate: -90, opacity: 0, scale: 0.5 },
      { rotate: 0, opacity: 1, scale: 1, duration: 0.4, ease: 'back.out(2.5)' },
    )
  }, [theme])

  return (
    <header className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background/80 px-3 py-3 backdrop-blur sm:px-4">
      <Button variant="ghost" size="icon-sm" onClick={onToggleSidebar} aria-label="切换侧边栏">
        <PanelLeft className="size-4" />
      </Button>
      {sidebarCollapsed && <BrandMark className="size-6 shrink-0" />}
      <span className="hidden text-sm font-medium text-muted-foreground sm:inline">Agent 控制台</span>
      <div className="ml-auto flex items-center gap-2 sm:gap-3">
        {running && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex size-2 rounded-full bg-primary" />
            </span>
            <span className="hidden sm:inline">运行中…</span>
          </span>
        )}
        <Button variant="ghost" size="icon-sm" onClick={onToggleTheme} aria-label="切换主题">
          <span ref={themeIconRef} className="inline-flex">
            {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </span>
        </Button>
      </div>
    </header>
  )
}
