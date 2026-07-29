import { useLayoutEffect, useRef, useState } from 'react'
import { get } from 'lodash-es'
import { gsap } from 'gsap'
import { CheckCircle2, ChevronDown, FileCode, Globe, Loader2, Search, Terminal } from 'lucide-react'
import { cn } from '@autonoma/ui/lib/utils'
import type { Block } from '@/types/blocks'
import { cleanSnippet, hostname, parseResult, prettyJson } from '@/lib/format'

const TOOL_META: Record<string, { icon: typeof Terminal; label: string }> = {
  run_command: { icon: Terminal, label: '命令' },
  write_file: { icon: FileCode, label: '文件' },
  web_search: { icon: Search, label: '搜索' },
}

function toolSummary(name: string, args: unknown): string {
  if (name === 'run_command') return String(get(args, 'command', ''))
  if (name === 'write_file') return String(get(args, 'path', ''))
  if (name === 'web_search') return String(get(args, 'query', ''))
  return name
}

export function ToolCard({ block }: { block: Extract<Block, { kind: 'tool' }> }) {
  const meta = TOOL_META[block.name]
  const Icon = meta?.icon ?? Terminal
  const [open, setOpen] = useState(true)
  const bodyRef = useRef<HTMLDivElement>(null)
  const mounted = useRef(false)

  // Animate height on toggle, but not on first mount — cards default open and
  // should just render at their natural height, not animate in from zero.
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    if (!mounted.current) {
      mounted.current = true
      return
    }
    if (open) {
      const target = el.scrollHeight
      gsap.fromTo(
        el,
        { height: 0, opacity: 0 },
        { height: target, opacity: 1, duration: 0.3, ease: 'power2.out', onComplete: () => gsap.set(el, { height: 'auto' }) },
      )
    } else {
      gsap.to(el, { height: 0, opacity: 0, duration: 0.22, ease: 'power2.in' })
    }
  }, [open])

  return (
    <div className="overflow-hidden rounded-lg border bg-card transition-shadow hover:shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm"
      >
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
          <CheckCircle2 className="animate-in zoom-in-50 size-3.5 shrink-0 text-primary duration-300" />
        )}
        <ChevronDown
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>
      <div ref={bodyRef} className={cn('overflow-hidden', !open && 'h-0 opacity-0')}>
        <div className="border-t px-3 py-2.5">
          <ToolBody block={block} />
        </div>
      </div>
    </div>
  )
}

function ToolBody({ block }: { block: Extract<Block, { kind: 'tool' }> }) {
  if (block.name === 'run_command') {
    const result = parseResult<{ exitCode: number; stdout: string; stderr: string }>(block.result)
    return (
      <div className="space-y-2">
        <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">
          $ {String(get(block.args, 'command', ''))}
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
退出码 {result.exitCode}
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
    return (
      <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
        {String(get(block.args, 'content', ''))}
      </pre>
    )
  }

  if (block.name === 'web_search') {
    const result = parseResult<{
      error?: string
      results?: { title: string; url: string; snippet: string }[]
    }>(block.result)

    if (block.result === undefined) {
      return (
        <div className="space-y-1.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-start gap-2.5 rounded-xl bg-muted/40 px-3 py-2.5">
              <div className="mt-0.5 size-4 shrink-0 animate-pulse rounded-sm bg-muted-foreground/15" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="h-2.5 w-1/3 animate-pulse rounded-full bg-muted-foreground/15" />
                <div className="h-2.5 w-4/5 animate-pulse rounded-full bg-muted-foreground/15" />
              </div>
            </div>
          ))}
        </div>
      )
    }
    if (result?.error) {
      return (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {result.error}
        </p>
      )
    }
    return (
      <div className="space-y-1.5">
        {result?.results && result.results.length > 0 && (
          <p className="px-0.5 text-[11px] text-muted-foreground">找到 {result.results.length} 个结果</p>
        )}
        {result?.results?.map((r, i) => (
          <a
            key={i}
            href={r.url}
            target="_blank"
            rel="noreferrer"
            className="group flex items-start gap-2.5 rounded-xl border border-transparent bg-muted/40 px-3 py-2.5 text-xs transition-all hover:border-border hover:bg-muted hover:shadow-sm"
          >
            <span className="relative mt-0.5 flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-muted-foreground/10">
              <Globe className="absolute size-3 text-muted-foreground" />
              <img
                src={`https://www.google.com/s2/favicons?sz=64&domain=${hostname(r.url)}`}
                alt=""
                className="relative size-4"
                onError={(e) => {
                  e.currentTarget.style.display = 'none'
                }}
              />
            </span>
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="truncate text-[11px] text-muted-foreground">{hostname(r.url)}</div>
              <div className="truncate font-medium text-foreground group-hover:text-primary">{r.title}</div>
              <div className="line-clamp-2 text-muted-foreground">{cleanSnippet(r.snippet)}</div>
            </div>
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
