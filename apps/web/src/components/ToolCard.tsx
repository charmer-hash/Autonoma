import { useLayoutEffect, useRef, useState } from 'react'
import { get } from 'lodash-es'
import { gsap } from 'gsap'
import { CheckCircle2, ChevronDown, FileCode, Loader2, Search, Terminal } from 'lucide-react'
import { cn } from '@autonoma/ui/lib/utils'
import type { Block } from '@/types/blocks'
import { JsonFallbackResult } from './tool-results/JsonFallbackResult'
import { RunCommandResult } from './tool-results/RunCommandResult'
import { WebSearchResult } from './tool-results/WebSearchResult'
import { WriteFileResult } from './tool-results/WriteFileResult'

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
  if (block.name === 'run_command') return <RunCommandResult block={block} />
  if (block.name === 'write_file') return <WriteFileResult block={block} />
  if (block.name === 'web_search') return <WebSearchResult block={block} />
  return <JsonFallbackResult block={block} />
}
