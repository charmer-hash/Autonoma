import { useState } from "react";
import { ConfirmLogoutDialog } from "@/components/ConfirmLogoutDialog";
import { ConsoleHeader } from "@/components/ConsoleHeader";
import { Composer } from "@/components/Composer";
import { MessageList } from "@/components/MessageList";
import { Sidebar } from "@/components/Sidebar";
import { useConsoleSession } from "@/hooks/useConsoleSession";

export function Console({ onLogout }: { onLogout: () => void }) {
  const {
    task,
    setTask,
    blocks,
    running,
    sessionId,
    sessions,
    handleNewSession,
    loadSession,
    run,
  } = useConsoleSession();

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    document.documentElement.classList.contains("dark") ? "dark" : "light",
  );
  console.log('theme', theme);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.classList.toggle("dark", next === "dark");
    localStorage.setItem("theme", next);
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
        <ConsoleHeader
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
          running={running}
          theme={theme}
          onToggleTheme={toggleTheme}
          onLogoutClick={() => setLogoutConfirmOpen(true)}
        />
        <MessageList blocks={blocks} running={running} />
        <Composer
          task={task}
          setTask={setTask}
          running={running}
          onSend={run}
        />
      </div>

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
