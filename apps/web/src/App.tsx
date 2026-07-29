import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  ArrowUp,
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Download,
  FileCode,
  FileText,
  Globe,
  Loader2,
  Moon,
  Paperclip,
  PanelLeft,
  Plus,
  Search,
  Settings,
  Sparkles,
  Sun,
  Terminal,
  User,
} from 'lucide-react'
import { Button } from '@autonoma/ui/components/button'
import { Textarea } from '@autonoma/ui/components/textarea'
import { cn } from '@autonoma/ui/lib/utils'
import { runAgent } from '@/lib/agent-events'

type Block =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; args: unknown; result?: string; status: 'running' | 'done' }
  | { kind: 'document'; name: string; content: string }
  | { kind: 'error'; text: string }

function downloadText(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

type Group =
  | { role: 'user'; text: string }
  | { role: 'assistant'; blocks: Exclude<Block, { kind: 'user' }>[] }

// Groups consecutive non-user blocks together so a whole turn's tool calls +
// text share one avatar, the way Slack/Discord/ChatGPT group same-sender messages.
function groupBlocks(blocks: Block[]): Group[] {
  const groups: Group[] = []
  for (const block of blocks) {
    if (block.kind === 'user') {
      groups.push({ role: 'user', text: block.text })
      continue
    }
    const last = groups[groups.length - 1]
    if (last?.role === 'assistant') {
      last.blocks.push(block)
    } else {
      groups.push({ role: 'assistant', blocks: [block] })
    }
  }
  return groups
}

function prettyJson(value: unknown): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

function parseResult<T>(result: string | undefined): T | null {
  if (result === undefined) return null
  try {
    return JSON.parse(result) as T
  } catch {
    return null
  }
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

const TOOL_META: Record<string, { icon: typeof Terminal; label: string }> = {
  run_command: { icon: Terminal, label: 'Command' },
  write_file: { icon: FileCode, label: 'File' },
  web_search: { icon: Search, label: 'Search' },
}

function toolSummary(name: string, args: unknown): string {
  const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
  if (name === 'run_command') return String(a.command ?? '')
  if (name === 'write_file') return String(a.path ?? '')
  if (name === 'web_search') return String(a.query ?? '')
  return name
}

function ToolCard({ block }: { block: Extract<Block, { kind: 'tool' }> }) {
  const meta = TOOL_META[block.name]
  const Icon = meta?.icon ?? Terminal

  return (
    <details open className="group overflow-hidden rounded-lg border bg-card">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm [&::-webkit-details-marker]:hidden">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Icon className="size-3" />
        </span>
        <span className="shrink-0 text-xs font-medium text-muted-foreground">
          {meta?.label ?? block.name}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          {toolSummary(block.name, block.args)}
        </span>
        {block.status === 'running' ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
        ) : (
          <CheckCircle2 className="size-3.5 shrink-0 text-primary" />
        )}
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t px-3 py-2.5">
        <ToolBody block={block} />
      </div>
    </details>
  )
}

function ToolBody({ block }: { block: Extract<Block, { kind: 'tool' }> }) {
  if (block.name === 'run_command') {
    const args = block.args as { command?: unknown }
    const result = parseResult<{ exitCode: number; stdout: string; stderr: string }>(block.result)
    return (
      <div className="space-y-2">
        <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">
          $ {String(args?.command ?? '')}
        </pre>
        {result && (
          <>
            <span
              className={cn(
                'inline-block rounded px-1.5 py-0.5 text-[10px] font-medium',
                result.exitCode === 0
                  ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                  : 'bg-destructive/15 text-destructive',
              )}
            >
              exit {result.exitCode}
            </span>
            {result.stdout && (
              <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
                {result.stdout}
              </pre>
            )}
            {result.stderr && (
              <pre className="overflow-x-auto rounded-md bg-destructive/10 p-2 font-mono text-xs whitespace-pre-wrap text-destructive">
                {result.stderr}
              </pre>
            )}
          </>
        )}
      </div>
    )
  }

  if (block.name === 'write_file') {
    const args = block.args as { path?: unknown; content?: unknown }
    return (
      <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
        {String(args?.content ?? '')}
      </pre>
    )
  }

  if (block.name === 'web_search') {
    const result = parseResult<{
      error?: string
      results?: { title: string; url: string; snippet: string }[]
    }>(block.result)

    if (block.result === undefined) {
      return <p className="text-xs text-muted-foreground">Searching…</p>
    }
    if (result?.error) {
      return <p className="text-xs text-muted-foreground">{result.error}</p>
    }
    return (
      <div className="space-y-1.5">
        {result?.results?.map((r, i) => (
          <a
            key={i}
            href={r.url}
            target="_blank"
            rel="noreferrer"
            className="block rounded-md border px-2.5 py-2 text-xs transition-colors hover:bg-muted"
          >
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Globe className="size-3 shrink-0" />
              <span className="truncate">{hostname(r.url)}</span>
            </div>
            <div className="mt-0.5 truncate font-medium text-foreground">{r.title}</div>
            <div className="mt-0.5 line-clamp-2 text-muted-foreground">{r.snippet}</div>
          </a>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">{prettyJson(block.args)}</pre>
      {block.result !== undefined && (
        <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">{prettyJson(block.result)}</pre>
      )}
    </div>
  )
}

function Markdown({ text }: { text: string }) {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none prose-pre:bg-muted prose-pre:text-foreground">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  )
}

function BlockView({
  block,
  live,
}: {
  block: Exclude<Block, { kind: 'user' }>
  live?: boolean
}) {
  if (block.kind === 'text') {
    if (live) {
      // Plain text while streaming so the cursor can sit inline at the end —
      // once the turn finishes this block re-renders through Markdown instead.
      return (
        <p className="text-sm leading-relaxed whitespace-pre-wrap">
          {block.text}
          <span className="ml-0.5 inline-block h-4 w-[3px] translate-y-0.5 animate-pulse bg-foreground align-middle" />
        </p>
      )
    }
    return <Markdown text={block.text} />
  }

  if (block.kind === 'document') {
    return (
      <div className="overflow-hidden rounded-lg border bg-card">
        <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
          <FileText className="size-4 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{block.name}</span>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => downloadText(block.name, block.content)}
            aria-label={`Download ${block.name}`}
          >
            <Download className="size-4" />
          </Button>
        </div>
        <div className="max-h-96 overflow-y-auto px-4 py-3">
          <Markdown text={block.content} />
        </div>
      </div>
    )
  }

  if (block.kind === 'error') {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        <span>{block.text}</span>
      </div>
    )
  }

  return <ToolCard block={block} />
}

// Left rail: session list + agent config. Both are placeholders — wired up once
// the server has persistence (Neon). Layout is real now so those features slot
// in later without another restructure.
function Sidebar({ collapsed }: { collapsed: boolean }) {
  return (
    <aside
      className={
        'flex shrink-0 flex-col overflow-hidden border-r bg-sidebar text-sidebar-foreground transition-[width] duration-200 ' +
        (collapsed ? 'w-0 border-r-0' : 'w-64')
      }
    >
      <div className="flex items-center gap-2 px-4 py-3.5">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Sparkles className="size-4" />
        </div>
        <span className="font-semibold whitespace-nowrap">Autonoma</span>
      </div>

      <div className="px-3">
        <Button
          variant="outline"
          className="w-full justify-start gap-2 text-sidebar-foreground"
          disabled
          title="Coming soon"
        >
          <Plus className="size-4" />
          New session
        </Button>
      </div>

      <div className="mt-4 flex-1 overflow-y-auto px-3">
        <p className="px-1 text-xs font-medium text-sidebar-foreground/50">Sessions</p>
        <p className="mt-2 px-1 text-xs text-sidebar-foreground/40">History coming soon</p>
      </div>

      <div className="border-t px-3 py-3">
        <Button
          variant="ghost"
          className="w-full justify-start gap-2 text-sidebar-foreground/70"
          disabled
          title="Coming soon"
        >
          <Settings className="size-4" />
          Agent settings
        </Button>
      </div>
    </aside>
  )
}

function App() {
  const [task, setTask] = useState('')
  const [blocks, setBlocks] = useState<Block[]>([])
  const [running, setRunning] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  )
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [blocks])

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    document.documentElement.classList.toggle('dark', next === 'dark')
    localStorage.setItem('theme', next)
  }

  function appendText(delta: string) {
    setBlocks((prev) => {
      const last = prev[prev.length - 1]
      if (last?.kind === 'text') {
        return [...prev.slice(0, -1), { kind: 'text', text: last.text + delta }]
      }
      return [...prev, { kind: 'text', text: delta }]
    })
  }

  function startTool(name: string, args: unknown) {
    setBlocks((prev) => [...prev, { kind: 'tool', name, args, status: 'running' }])
  }

  function finishTool(result: string) {
    setBlocks((prev) => {
      const last = prev[prev.length - 1]
      if (last?.kind !== 'tool') return prev
      return [...prev.slice(0, -1), { ...last, result, status: 'done' }]
    })
  }

  function appendError(text: string) {
    setBlocks((prev) => [...prev, { kind: 'error', text }])
  }

  function appendDocument(name: string, content: string) {
    setBlocks((prev) => [...prev, { kind: 'document', name, content }])
  }

  async function run() {
    const currentTask = task.trim()
    if (!currentTask || running) return

    setTask('')
    setBlocks((prev) => [...prev, { kind: 'user', text: currentTask }])
    setRunning(true)
    try {
      for await (const event of runAgent(currentTask)) {
        switch (event.type) {
          case 'text_delta':
            appendText(event.delta)
            break
          case 'tool_call':
            startTool(event.name, event.args)
            break
          case 'tool_result':
            finishTool(event.result)
            break
          case 'document':
            appendDocument(event.name, event.content)
            break
          case 'error':
            appendError(event.message)
            break
          case 'done':
            break
        }
      }
    } catch (err) {
      appendError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      run()
    }
  }

  return (
    <div className="flex h-svh bg-background text-foreground">
      <Sidebar collapsed={sidebarCollapsed} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background/80 px-4 py-3 backdrop-blur">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setSidebarCollapsed((v) => !v)}
            aria-label="Toggle sidebar"
          >
            <PanelLeft className="size-4" />
          </Button>
          <span className="text-sm font-medium text-muted-foreground">Agent Console</span>
          <div className="ml-auto flex items-center gap-3">
            {running && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="relative flex size-2">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
                  <span className="relative inline-flex size-2 rounded-full bg-primary" />
                </span>
                Working…
              </span>
            )}
            <Button variant="ghost" size="icon-sm" onClick={toggleTheme} aria-label="Toggle theme">
              {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </Button>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-3 px-6 py-8">
            {blocks.length === 0 && !running && (
              <div className="flex flex-col items-center justify-center gap-3 py-24 text-center text-muted-foreground">
                <Bot className="size-8" />
                <p className="max-w-sm text-sm">
                  Describe a task below — research, planning, or code — and the agent will work
                  through it step by step.
                </p>
              </div>
            )}
            {(() => {
              const groups = groupBlocks(blocks)
              return groups.map((group, i) =>
                group.role === 'user' ? (
                  <div key={i} className="flex items-start justify-end gap-2">
                    <div className="max-w-[75%] rounded-2xl bg-primary px-4 py-2 text-sm whitespace-pre-wrap text-primary-foreground">
                      {group.text}
                    </div>
                    <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
                      <User className="size-4" />
                    </div>
                  </div>
                ) : (
                  <div key={i} className="flex items-start gap-2">
                    <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                      <Sparkles className="size-4" />
                    </div>
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
              )
            })()}
            {running && blocks[blocks.length - 1]?.kind === 'user' && (
              <div className="flex items-start gap-2">
                <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <Sparkles className="size-4 animate-pulse" />
                </div>
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
          <div className="mx-auto max-w-3xl rounded-2xl border bg-card p-2 shadow-sm">
            <Textarea
              value={task}
              onChange={(e) => setTask(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder='Describe a task, e.g. "Plan a weekend trip" or "Write a Python script that prints the first 10 Fibonacci numbers, then run it."'
              disabled={running}
              rows={1}
              className="max-h-40 resize-none border-0 bg-transparent px-2 shadow-none focus-visible:border-transparent focus-visible:ring-0"
            />
            <div className="flex items-center justify-between px-1 pt-1">
              <Button variant="ghost" size="icon-sm" disabled title="File uploads coming soon">
                <Paperclip className="size-4" />
              </Button>
              <Button size="icon-sm" onClick={run} disabled={running || !task.trim()} aria-label="Run">
                {running ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
              </Button>
            </div>
          </div>
        </footer>
      </div>
    </div>
  )
}

export default App
