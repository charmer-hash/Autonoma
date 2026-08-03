import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { last as lastOf } from 'lodash-es'
import { gsap } from 'gsap'
import { Paperclip, User } from 'lucide-react'
import { cn } from '@autonoma/ui/lib/utils'
import type { PreviewPanelController } from '@/hooks/usePreviewPanel'
import type { Block } from '@/types/blocks'
import { groupBlocks } from '@/lib/blocks'
import { formatBytes } from '@/lib/format'
import { BlockView } from './BlockView'
import { BrandMark } from './BrandMark'

// Shapes loosely mimic a real exchange (assistant reply, short user reply,
// longer assistant reply) so the placeholder reads as "a conversation is
// about to appear" rather than a generic grid of bars.
const SKELETON_ROWS: { align: 'start' | 'end'; widths: string[] }[] = [
  { align: 'start', widths: ['65%', '40%'] },
  { align: 'end', widths: ['42%'] },
  { align: 'start', widths: ['55%', '38%', '48%'] },
]

export function MessageList({
  blocks,
  running,
  loading,
  panel,
}: {
  blocks: Block[]
  running: boolean
  loading?: boolean
  panel: PreviewPanelController
}) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const groupRefs = useRef<(HTMLDivElement | null)[]>([])
  const prevGroupCount = useRef(0)

  const groups = useMemo(() => groupBlocks(blocks), [blocks])

  useEffect(() => {
    // Smooth while a turn is actively streaming (nice to watch the reply
    // grow into view); an instant jump when a session is first opened or
    // switched — nobody wants to watch a scroll through someone's whole
    // history just to land at the bottom.
    bottomRef.current?.scrollIntoView({ block: 'end', behavior: running ? 'smooth' : 'instant' })
  }, [blocks, running])

  // Pop in a group only when it's the single new one appended live — a turn
  // actually producing new output. When several groups appear in the same
  // update (opening a session loads its whole history at once), that's old
  // content, not something new happening — animating it in reads as motion
  // for no reason, so it should just be there, like a chat app landing on
  // an existing thread.
  useLayoutEffect(() => {
    const grown = groups.length - prevGroupCount.current
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!reduceMotion && grown === 1) {
      const el = groupRefs.current[groups.length - 1]
      if (el) gsap.from(el, { opacity: 0, y: 10, duration: 0.35, ease: 'power2.out' })
    }
    prevGroupCount.current = groups.length
  }, [groups.length])

  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-3 px-3 py-4 sm:px-6 sm:py-8">
        {loading ? (
          <div className="space-y-4">
            {SKELETON_ROWS.map((row, i) => (
              <div
                key={i}
                className={cn('flex animate-pulse items-start gap-2', row.align === 'end' && 'justify-end')}
                style={{ animationDelay: `${i * 150}ms` }}
              >
                {row.align === 'start' && <div className="size-7 shrink-0 rounded-full bg-muted" />}
                {row.align === 'end' ? (
                  <div className="h-8 rounded-2xl bg-muted" style={{ width: row.widths[0] }} />
                ) : (
                  <div className="min-w-0 flex-1 space-y-2 pt-1">
                    {row.widths.map((width, j) => (
                      <div key={j} className="h-3 max-w-[80%] rounded-full bg-muted" style={{ width }} />
                    ))}
                  </div>
                )}
                {row.align === 'end' && <div className="size-7 shrink-0 rounded-full bg-muted" />}
              </div>
            ))}
          </div>
        ) : (
          <>
            {blocks.length === 0 && !running && (
              <div className="animate-in fade-in-0 zoom-in-95 relative flex flex-col items-center justify-center gap-3 py-24 text-center text-muted-foreground duration-700">
                <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div className="h-80 w-80 rounded-full bg-[radial-gradient(circle,color-mix(in_oklch,var(--primary)_20%,transparent)_0%,color-mix(in_oklch,var(--chart-2)_12%,transparent)_45%,transparent_72%)] blur-2xl" />
                </div>
                <BrandMark className="relative h-14 w-auto drop-shadow-[0_10px_24px_color-mix(in_oklch,var(--primary)_35%,transparent)]" />
                <p className="relative max-w-sm text-sm">
                  在下方描述一个任务——研究、规划或写代码——Agent 会一步步帮你完成。
                </p>
              </div>
            )}
            {groups.map((group, i) =>
              group.role === 'user' ? (
                <div
                  key={i}
                  ref={(el) => {
                    groupRefs.current[i] = el
                  }}
                  className="flex items-start justify-end gap-2"
                >
                  <div className="flex max-w-[75%] flex-col items-end gap-1.5">
                    {group.attachments && group.attachments.length > 0 && (
                      <div className="flex flex-wrap justify-end gap-1.5">
                        {group.attachments.map((a, i) => (
                          <div
                            key={i}
                            className="flex items-center gap-1.5 rounded-lg border bg-card px-2.5 py-1.5 text-xs"
                          >
                            <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
                            <span className="max-w-40 truncate font-medium">{a.filename}</span>
                            <span className="shrink-0 text-muted-foreground">{formatBytes(a.size)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="rounded-2xl bg-primary px-4 py-2 text-sm whitespace-pre-wrap text-primary-foreground">
                      {group.text}
                    </div>
                  </div>
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
                    <User className="size-4" />
                  </div>
                </div>
              ) : (
                <div
                  key={i}
                  ref={(el) => {
                    groupRefs.current[i] = el
                  }}
                  className="flex items-start gap-2"
                >
                  <BrandMark className="size-7 shrink-0" />
                  <div className="min-w-0 flex-1 space-y-2">
                    {group.blocks.map((block, j) => (
                      <BlockView
                        key={'id' in block ? block.id : j}
                        block={block}
                        live={running && i === groups.length - 1 && j === group.blocks.length - 1}
                        panel={panel}
                      />
                    ))}
                    {/* A tool call finishing (status -> 'done') is a silent jump —
                        no more sweep animation, no next block yet either. Without
                        this, the page shows nothing happening in between, even
                        though the agent is still working (deciding the next step,
                        or about to stream its reply). Reuses the same breathing
                        dot as the pre-first-block indicator below, minus the
                        avatar — this one continues the existing group instead of
                        starting a new row. */}
                    {running &&
                      i === groups.length - 1 &&
                      lastOf(group.blocks)?.kind === 'tool' &&
                      (lastOf(group.blocks) as Extract<Block, { kind: 'tool' }>).status === 'done' && (
                        <div className="flex items-center pt-1">
                          <span className="size-2 rounded-full bg-primary [animation:breathing-glow_1.6s_ease-in-out_infinite]" />
                        </div>
                      )}
                  </div>
                </div>
              ),
            )}
            {running && lastOf(blocks)?.kind === 'user' && (
              <div className="flex items-start gap-2">
                <BrandMark className="size-7 shrink-0 animate-pulse" />
                <div className="flex items-center pt-3.5">
                  <span className="size-2 rounded-full bg-primary [animation:breathing-glow_1.6s_ease-in-out_infinite]" />
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </>
        )}
      </div>
    </main>
  )
}
