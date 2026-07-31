import { useState } from "react";
import { ConfirmLogoutDialog } from "@/components/ConfirmLogoutDialog";
import { ConsoleHeader } from "@/components/ConsoleHeader";
import { Composer } from "@/components/Composer";
import { MessageList } from "@/components/MessageList";
import { Sidebar } from "@/components/Sidebar";
import { useConsoleSession } from "@/hooks/useConsoleSession";
import { useIsMobile } from "@/hooks/useIsMobile";

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
  // On mobile the sidebar is an overlay drawer, so it should start closed;
  // on desktop it's an in-flow panel that starts open. Only the *initial*
  // value comes from isMobile — later viewport changes don't fight the
  // user's own toggle.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(isMobile);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    document.documentElement.classList.contains("dark") ? "dark" : "light",
  );

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.classList.toggle("dark", next === "dark");
    localStorage.setItem("theme", next);
  }

  // On mobile the sidebar is an overlay covering the console, so picking a
  // session (or starting a new one) should also dismiss it — on desktop it's
  // an in-flow panel the user explicitly toggles, so leave it alone there.
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
        <MessageList blocks={blocks} running={running} loading={messagesLoading} />
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
