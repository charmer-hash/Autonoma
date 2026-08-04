import { useEffect, useState } from "react";
import { AgentSettingsDialog } from "@/components/AgentSettingsDialog";
import { ConfirmLogoutDialog } from "@/components/ConfirmLogoutDialog";
import { ConsoleHeader } from "@/components/ConsoleHeader";
import { Composer } from "@/components/Composer";
import { MessageList } from "@/components/MessageList";
import { PreviewPanel } from "@/components/PreviewPanel";
import { Sidebar } from "@/components/Sidebar";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useConsoleStore } from "@/store/consoleStore";

export function Console({ username, onLogout }: { username: string | undefined; onLogout: () => void }) {
  // 只拉这两个动作、不订阅任何会随每个 SSE token 变化的状态（如
  // blocks）——Console 本身不再因为流式输出而重渲染，级联到
  // Sidebar/ConsoleHeader/Composer 的问题也就不存在了：它们现在各自
  // 直接从 store 里按需订阅自己关心的切片。
  const initialize = useConsoleStore((s) => s.initialize);
  const handleNewSession = useConsoleStore((s) => s.handleNewSession);
  const loadSession = useConsoleStore((s) => s.loadSession);

  useEffect(() => {
    initialize();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isMobile = useIsMobile();
  // 在移动端，侧边栏是一个覆盖式抽屉，所以应该以关闭状态开始；
  // 在桌面端，它是一个常驻面板，默认是打开的。只有*初始*值来自
  // isMobile——之后视口的变化不会与用户自己的切换操作相冲突。
  const [sidebarCollapsed, setSidebarCollapsed] = useState(isMobile);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const [agentSettingsOpen, setAgentSettingsOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    document.documentElement.classList.contains("dark") ? "dark" : "light",
  );

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.classList.toggle("dark", next === "dark");
    localStorage.setItem("theme", next);
  }

  // 在移动端，侧边栏是覆盖在控制台上方的浮层，所以选择一个会话（或
  // 新建一个会话）时也应该把它关闭——在桌面端它是用户手动切换的
  // 常驻面板，所以在那里保持原样不动。
  function handleNewSessionMobileAware() {
    handleNewSession();
    if (isMobile) setSidebarCollapsed(true);
  }
  function loadSessionMobileAware(id: string) {
    loadSession(id);
    if (isMobile) setSidebarCollapsed(true);
  }

  return (
    <div className="flex h-svh bg-background text-foreground">
      <Sidebar
        collapsed={sidebarCollapsed}
        onNewSession={handleNewSessionMobileAware}
        onSelectSession={loadSessionMobileAware}
        onClose={() => setSidebarCollapsed(true)}
        username={username}
        onOpenSettings={() => setAgentSettingsOpen(true)}
        onLogoutClick={() => setLogoutConfirmOpen(true)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <ConsoleHeader
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
          theme={theme}
          onToggleTheme={toggleTheme}
        />
        <MessageList />
        <Composer />
      </div>

      <PreviewPanel />

      <ConfirmLogoutDialog
        open={logoutConfirmOpen}
        onCancel={() => setLogoutConfirmOpen(false)}
        onConfirm={() => {
          setLogoutConfirmOpen(false);
          onLogout();
        }}
      />

      <AgentSettingsDialog open={agentSettingsOpen} onClose={() => setAgentSettingsOpen(false)} />
    </div>
  );
}
