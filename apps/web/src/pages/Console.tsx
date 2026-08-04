import { useEffect, useRef, useState } from "react";
import { ConfirmLogoutDialog } from "@/components/ConfirmLogoutDialog";
import { ConsoleHeader } from "@/components/ConsoleHeader";
import { Composer } from "@/components/Composer";
import { MessageList } from "@/components/MessageList";
import { PreviewPanel } from "@/components/PreviewPanel";
import { Sidebar } from "@/components/Sidebar";
import { useConsoleSession } from "@/hooks/useConsoleSession";
import { useIsMobile } from "@/hooks/useIsMobile";
import { usePreviewPanel } from "@/hooks/usePreviewPanel";

export function Console({ onLogout }: { onLogout: () => void }) {
  const {
    task,
    setTask,
    blocks,
    running,
    sessionId,
    sessions,
    sessionsLoading,
    messagesLoading,
    handleNewSession,
    loadSession,
    run,
  } = useConsoleSession();

  const isMobile = useIsMobile();
  // 在移动端，侧边栏是一个覆盖式抽屉，所以应该以关闭状态开始；
  // 在桌面端，它是一个常驻面板，默认是打开的。只有*初始*值来自
  // isMobile——之后视口的变化不会与用户自己的切换操作相冲突。
  const [sidebarCollapsed, setSidebarCollapsed] = useState(isMobile);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const panel = usePreviewPanel();

  // 一旦某个工具调用开始运行就立刻自动打开面板，这样观察 agent 工作
  // 就不需要点击任何东西。用 id 做保护，防止同一个仍在运行的 block
  // 重新渲染时重复触发；同时依赖 usePreviewPanel 自身的 allowAutoOpen，
  // 防止用户刚关闭的面板在同一次运行的下一个工具调用时立刻重新打开。
  const lastAutoOpenedToolId = useRef<string | undefined>(undefined);
  useEffect(() => {
    const last = blocks[blocks.length - 1];
    if (last?.kind === "tool" && last.status === "running" && last.id !== lastAutoOpenedToolId.current) {
      lastAutoOpenedToolId.current = last.id;
      panel.autoOpen({ kind: "tool", id: last.id });
    }
    // panel 的方法只会调用 setState——在各次渲染中行为都是一样的，
    // 所以在这里省略它不会有闭包过期的风险。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks]);

  // 新的一轮对话会重新获得自动打开的机会，即使用户在上一轮进行到
  // 一半时关闭了面板。
  const wasRunning = useRef(running);
  useEffect(() => {
    if (running && !wasRunning.current) panel.resetAutoOpen();
    wasRunning.current = running;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);
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
        sessions={sessions}
        sessionsLoading={sessionsLoading}
        activeSessionId={sessionId}
        disabled={running}
        onNewSession={handleNewSessionMobileAware}
        onSelectSession={loadSessionMobileAware}
        onClose={() => setSidebarCollapsed(true)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <ConsoleHeader
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
          running={running}
          theme={theme}
          onToggleTheme={toggleTheme}
          onLogoutClick={() => setLogoutConfirmOpen(true)}
        />
        <MessageList blocks={blocks} running={running} loading={messagesLoading} panel={panel} />
        <Composer
          task={task}
          setTask={setTask}
          running={running}
          onSend={run}
        />
      </div>

      <PreviewPanel panel={panel} blocks={blocks} />

      <ConfirmLogoutDialog
        open={logoutConfirmOpen}
        onCancel={() => setLogoutConfirmOpen(false)}
        onConfirm={() => {
          setLogoutConfirmOpen(false);
          onLogout();
        }}
      />
    </div>
  );
}
