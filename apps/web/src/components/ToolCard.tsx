import { useLayoutEffect, useRef, useState } from 'react'
import { gsap } from 'gsap'
import { CheckCircle2, ChevronDown, Loader2, Maximize2, Terminal } from 'lucide-react'
import { Button } from '@autonoma/ui/components/button'
import { cn } from '@autonoma/ui/lib/utils'
import type { PreviewPanelController } from '@/hooks/usePreviewPanel'
import type { Block } from '@/types/blocks'
import { getToolResultComponent, TOOL_META, toolSummary } from '@/lib/tool-meta'

export function ToolCard({ block, panel }: { block: Extract<Block, { kind: 'tool' }>; panel: PreviewPanelController }) {
  const meta = TOOL_META[block.name]
  const Icon = meta?.icon ?? Terminal
  // Open by default only for a call that's actively running when it first
  // mounts — i.e. one happening live, right now, that the user is watching.
  // A call that's already 'done' at mount (loaded from history, or an
  // earlier turn in the same session) starts collapsed — otherwise opening
  // an old session with a dozen tool calls dumps every command's full
  // output at once. Deliberately only read at mount: once a running call
  // finishes, it stays open rather than snapping shut on the user.
  const [open, setOpen] = useState(() => block.status === 'running')
  const bodyRef = useRef<HTMLDivElement>(null)
  const mounted = useRef(false)

  // Animate height on toggle, but not on first mount — whatever a card's
  // initial open/collapsed state is, it should render at its natural
  // height immediately, not animate in from zero.
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
      <div className="relative flex w-full items-center gap-2 overflow-hidden px-3 py-2 text-sm">
        {block.status === 'running' && <RunningSweep />}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="relative z-10 flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
        >
          <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Icon className="size-3" />
          </span>
          <span className="shrink-0 text-xs font-medium text-muted-foreground">{meta?.label ?? block.name}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{toolSummary(block.name, block.args)}</span>
          {block.status === 'running' ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
          ) : (
            <CheckCircle2 className="animate-in zoom-in-50 size-3.5 shrink-0 text-primary duration-300" />
          )}
        </button>
        {/* Independent of the inline expand/collapse above — opens the same
            result in the right-side panel (full-height, uncapped) instead of
            the compact inline body below. Kept as a sibling button, not
            nested inside the toggle button above, since nested <button>s
            are invalid HTML and would double-fire on click. */}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => panel.open({ kind: 'tool', id: block.id })}
          aria-label="在右侧查看详情"
          className="relative z-10 size-5 shrink-0"
        >
          <Maximize2 className="size-3" />
        </Button>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? '收起详情' : '展开详情'}
          className="relative z-10 shrink-0"
        >
          <ChevronDown className={cn('size-3.5 text-muted-foreground transition-transform', open && 'rotate-180')} />
        </button>
      </div>
      <div ref={bodyRef} className={cn('overflow-hidden', !open && 'h-0 opacity-0')}>
        <div className="border-t px-3 py-2.5">
          <ToolBody block={block} />
        </div>
      </div>
    </div>
  )
}

// A soft diagonal light sweeps across the header while a tool call is
// in-flight — pure CSS (see the `tool-sweep` keyframe in index.css), no
// animation-library timeline needed for a simple infinite loop. Sits above
// the header's text (no z-index — content is explicitly `relative z-10`)
// so it visibly passes over the icon/label, not just behind them.
function RunningSweep() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        className="absolute inset-0 animate-[tool-sweep_2.2s_ease-in-out_infinite]"
        style={{
          background:
            'linear-gradient(100deg, transparent 30%, color-mix(in oklch, var(--primary) 18%, transparent) 50%, transparent 70%)',
        }}
      />
    </div>
  )
}

function ToolBody({ block }: { block: Extract<Block, { kind: 'tool' }> }) {
  const ResultComponent = getToolResultComponent(block.name)
  return <ResultComponent block={block} />
}
