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

// 形状大致模拟真实的对话（assistant 回复、简短的 user 回复、
// 较长的 assistant 回复），让占位内容看起来像“对话即将出现”，
// 而不是一堆通用的横条网格。
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
    // 一轮对话正在流式输出时使用平滑滚动（可以看着回复逐渐展开，效果不错）；
    // 而首次打开或切换会话时则直接瞬间跳转到底部——没有人想看着
    // 页面滚过整个历史记录，就为了最终落到底部。
    bottomRef.current?.scrollIntoView({ block: 'end', behavior: running ? 'smooth' : 'instant' })
  }, [blocks, running])

  // 仅当新增的是实时追加的单个 group 时才播放弹入动画——即真的有
  // 一轮对话在产生新输出。如果同一次更新里出现了多个 group（比如打开
  // 会话时一次性加载了全部历史记录），那些是旧内容，并非新发生的事情——
  // 给它们加动画只会是无意义的晃动，所以这种情况下应该直接静态展示，
  // 就像聊天应用打开一个已有的会话一样。
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
                    {/* 工具调用完成（status -> 'done'）是一次无声的跳变——
                        没有了扫光动画，下一个 block 也还没出现。如果不加这个，
                        页面在这期间会显得毫无动静，尽管 agent 其实仍在工作
                        （思考下一步，或者即将开始流式输出回复）。这里复用了
                        下方“首个 block 出现前”指示器同款的呼吸点动画，只是
                        去掉了头像——因为它是延续已有的 group，而不是新开一行。 */}
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
