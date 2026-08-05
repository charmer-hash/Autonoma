import { useLayoutEffect, useRef, useState } from 'react'
import { gsap } from 'gsap'
import { CheckCircle2, ChevronDown, CircleAlert, Loader2, Maximize2, Terminal, X } from 'lucide-react'
import { Button } from '@autonoma/ui/components/button'
import { cn } from '@autonoma/ui/lib/utils'
import type { Block } from '@/types/blocks'
import { getToolResultComponent, TOOL_META, toolSummary } from '@/lib/tool-meta'
import { useConsoleStore } from '@/store/consoleStore'
import { usePanelStore } from '@/store/panelStore'

export function ToolCard({ block }: { block: Extract<Block, { kind: 'tool' }> }) {
  const openPanel = usePanelStore((s) => s.open)
  const meta = TOOL_META[block.name]
  const Icon = meta?.icon ?? Terminal
  // 只有在挂载时正处于运行中/等待审批的调用才默认展开——也就是用户
  // 正在实时观看、或者需要马上做决定的那种。挂载时已经是 'done' 状态的
  // 调用（从历史记录加载，或者同一会话里更早的一轮对话）默认收起——
  // 否则打开一个有十几个工具调用的旧会话时，会把每个命令的完整输出
  // 一次性全部展示出来。这里刻意只在挂载时读取一次：一个正在运行的调用
  // 完成后会保持展开，而不会突然在用户面前收起。
  const [open, setOpen] = useState(() => block.status === 'running' || block.status === 'awaiting_approval')
  const bodyRef = useRef<HTMLDivElement>(null)
  const mounted = useRef(false)
  const respondToApproval = useConsoleStore((s) => s.respondToApproval)
  // 只用来控制批准/拒绝按钮本身的 loading/失败态——决定发出去之后 block
  // 的状态变化由 SSE 事件驱动（见 store/consoleStore.ts 的 startTool/
  // finishTool），不需要在这里自己更新 block。
  const [decision, setDecision] = useState<'idle' | 'submitting' | 'error'>('idle')

  async function handleApproval(approved: boolean) {
    setDecision('submitting')
    const ok = await respondToApproval(block.id, approved)
    if (!ok) setDecision('error')
    // 成功的话不用手动改回 'idle'——很快会收到 tool_call/tool_result 事件，
    // block.status 会变成 'running'/'done'，这个组件的审批横幅整体就不再
    // 渲染了，decision 这个局部 state 也就无所谓了。
  }

  // 切换时对高度做动画，但首次挂载时不做——无论卡片初始是展开还是收起状态，
  // 都应该立即以其自然高度渲染出来，而不是从零开始做进场动画。
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
          ) : block.status === 'awaiting_approval' ? (
            <CircleAlert className="size-3.5 shrink-0 text-warning" />
          ) : (
            <CheckCircle2 className="animate-in zoom-in-50 size-3.5 shrink-0 text-primary duration-300" />
          )}
        </button>
        {/* 与上方的行内展开/收起相互独立——在右侧面板（全高、无高度限制）中
            打开同一份结果，而不是下方那种紧凑的行内展示。这里作为兄弟按钮
            存在，而不是嵌套在上面的切换按钮内部，因为嵌套的 <button> 是无效的
            HTML，点击时会触发两次。 */}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => openPanel({ kind: 'tool', id: block.id })}
          aria-label="在右侧查看详情"
          className="relative z-10 size-5 shrink-0"
        >
          <Maximize2 className="size-3" />
        </Button>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? '收起详情' : '展开详情'}
          className="relative z-10 flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
        </button>
      </div>
      {/* 独立于上面的展开/收起——审批模式下用户必须能一眼看到需要决定，
          不能让它被折叠隐藏起来。 */}
      {block.status === 'awaiting_approval' && (
        <div className="flex flex-wrap items-center gap-2 border-t bg-warning/10 px-3 py-2 text-xs">
          <span className="min-w-0 flex-1 text-warning">该操作会改动沙箱状态，需要你确认后才会执行。</span>
          {decision === 'error' && <span className="text-destructive">提交失败，请重试</span>}
          <div className="flex shrink-0 gap-1.5">
            <Button
              variant="outline"
              size="sm"
              disabled={decision === 'submitting'}
              onClick={() => handleApproval(false)}
              className="h-7 gap-1 px-2 text-xs"
            >
              <X className="size-3" />
              拒绝
            </Button>
            <Button
              size="sm"
              disabled={decision === 'submitting'}
              onClick={() => handleApproval(true)}
              className="h-7 gap-1 px-2 text-xs"
            >
              {decision === 'submitting' ? <Loader2 className="size-3 animate-spin" /> : <CheckCircle2 className="size-3" />}
              批准
            </Button>
          </div>
        </div>
      )}
      <div ref={bodyRef} className={cn('overflow-hidden', !open && 'h-0 opacity-0')}>
        <div className="border-t px-3 py-2.5">
          <ToolBody block={block} />
        </div>
      </div>
    </div>
  )
}

// 工具调用进行中时，头部会有一道柔和的斜向光带扫过——纯 CSS 实现（参见
// index.css 中的 `tool-sweep` 关键帧），像这种简单的无限循环动画不需要动画库
// 的 timeline。它叠在头部文字之上（没有额外设置 z-index——内容本身显式设置了
// `relative z-10`），这样光带才会明显地从图标/标签上方掠过，而不只是从背后经过。
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
