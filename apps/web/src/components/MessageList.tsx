import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { last as lastOf } from 'lodash-es'
import { gsap } from 'gsap'
import { User } from 'lucide-react'
import type { Block } from '@/types/blocks'
import { groupBlocks } from '@/lib/blocks'
import { BlockView } from './BlockView'
import { BrandMark } from './BrandMark'

export function MessageList({ blocks, running }: { blocks: Block[]; running: boolean }) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const groupRefs = useRef<(HTMLDivElement | null)[]>([])
  const prevGroupCount = useRef(0)

  const groups = useMemo(() => groupBlocks(blocks), [blocks])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [blocks])

  // Pop in each new message group once, as it first appears — not on every
  // streamed token, since a group's contents keep growing after it's mounted.
  useLayoutEffect(() => {
    if (groups.length > prevGroupCount.current) {
      const el = groupRefs.current[groups.length - 1]
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      if (el && !reduceMotion) {
        gsap.from(el, { opacity: 0, y: 10, duration: 0.35, ease: 'power2.out' })
      }
    }
    prevGroupCount.current = groups.length
  }, [groups.length])

  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-3 px-6 py-8">
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
              <div className="max-w-[75%] rounded-2xl bg-primary px-4 py-2 text-sm whitespace-pre-wrap text-primary-foreground">
                {group.text}
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
                    key={j}
                    block={block}
                    live={running && i === groups.length - 1 && j === group.blocks.length - 1}
                  />
                ))}
              </div>
            </div>
          ),
        )}
        {running && lastOf(blocks)?.kind === 'user' && (
          <div className="flex items-start gap-2">
            <BrandMark className="size-7 shrink-0 animate-pulse" />
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
  )
}
