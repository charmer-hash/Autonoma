import { useState } from 'react'

export type PanelTarget = { kind: 'tool'; id: string } | { kind: 'artifact'; id: string }

// Deliberately just an {kind, id} pointer, never a copy of the block itself
// — PreviewPanel looks the block up live from the current `blocks` array on
// every render. A running tool's block mutates in place as it finishes (see
// useConsoleSession's finishTool); a captured snapshot would freeze the
// panel on whatever the block looked like at the moment it was opened.
export function usePreviewPanel() {
  const [target, setTarget] = useState<PanelTarget | null>(null)
  const [collapsed, setCollapsed] = useState(true)
  // Tracks whether autoOpen() is currently allowed to fire — the user
  // closing the panel mid-run is a signal they don't want to keep being
  // interrupted for the rest of that run, not a permanent preference (see
  // resetAutoOpen, called when a fresh run starts).
  const [allowAutoOpen, setAllowAutoOpen] = useState(true)

  function open(next: PanelTarget) {
    setTarget(next)
    setCollapsed(false)
    setAllowAutoOpen(true)
  }

  function autoOpen(next: PanelTarget) {
    if (!allowAutoOpen) return
    setTarget(next)
    setCollapsed(false)
  }

  function close() {
    setCollapsed(true)
    setAllowAutoOpen(false)
  }

  function resetAutoOpen() {
    setAllowAutoOpen(true)
  }

  return { target, collapsed, open, autoOpen, close, resetAutoOpen }
}

export type PreviewPanelController = ReturnType<typeof usePreviewPanel>
