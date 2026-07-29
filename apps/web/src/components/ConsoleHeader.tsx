import { LogOut, Moon, PanelLeft, Sun } from 'lucide-react'
import { Button } from '@autonoma/ui/components/button'
import { BrandMark } from '@/components/BrandMark'

export function ConsoleHeader({
  sidebarCollapsed,
  onToggleSidebar,
  running,
  theme,
  onToggleTheme,
  onLogoutClick,
}: {
  sidebarCollapsed: boolean
  onToggleSidebar: () => void
  running: boolean
  theme: 'light' | 'dark'
  onToggleTheme: () => void
  onLogoutClick: () => void
}) {
  return (
    <header className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background/80 px-4 py-3 backdrop-blur">
      <Button variant="ghost" size="icon-sm" onClick={onToggleSidebar} aria-label="切换侧边栏">
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
        <Button variant="ghost" size="icon-sm" onClick={onToggleTheme} aria-label="切换主题">
          {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onLogoutClick} aria-label="退出登录">
          <LogOut className="size-4" />
        </Button>
      </div>
    </header>
  )
}
