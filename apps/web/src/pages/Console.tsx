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
  // On mobile the sidebar is an overlay drawer, so it should start closed;
  // on desktop it's an in-flow panel that starts open. Only the *initial*
  // value comes from isMobile — later viewport changes don't fight the
  // user's own toggle.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(isMobile);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const panel = usePreviewPanel();

  // Auto-open the panel the instant a tool call starts running, so watching
  // the agent work doesn't require clicking anything. Guarded by id so a
  // re-render of the same still-running block doesn't re-trigger this, and
  // by usePreviewPanel's own allowAutoOpen so a panel the user just closed
  // doesn't immediately reopen for the next tool call in the same run.
  const lastAutoOpenedToolId = useRef<string | undefined>(undefined);
  useEffect(() => {
    const last = blocks[blocks.length - 1];
    if (last?.kind === "tool" && last.status === "running" && last.id !== lastAutoOpenedToolId.current) {
      lastAutoOpenedToolId.current = last.id;
      panel.autoOpen({ kind: "tool", id: last.id });
    }
    // panel's methods only ever call setState — behaviorally identical
    // across renders, so omitting it here doesn't risk a stale closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks]);

  // A fresh turn gets its own chance to auto-open, even if the user
  // dismissed the panel partway through the previous one.
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
