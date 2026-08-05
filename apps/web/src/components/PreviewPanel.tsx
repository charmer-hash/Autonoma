import { useMemo } from 'react'
import { CheckCircle2, File as FileIcon, FileText, Inbox, Loader2, Terminal, X } from 'lucide-react'
import { Button } from '@autonoma/ui/components/button'
import { cn } from '@autonoma/ui/lib/utils'
import type { Block } from '@/types/blocks'
import { getArtifactRawUrl } from '@/lib/artifacts-api'
import { getToolResultComponent, TOOL_META, toolSummary } from '@/lib/tool-meta'
import { useConsoleStore } from '@/store/consoleStore'
import { usePanelStore } from '@/store/panelStore'
import { FilePreview } from './file-preview/FilePreview'
import { Markdown } from './Markdown'

// 几乎完全镜像了 Sidebar.tsx 的双模式 CSS，只是镜像到了右侧：
// 移动端是通过 translate-x 滑入的固定定位抽屉（下方内容不会重排）；
// 桌面端（md 及以上）则回到文档流内的面板，通过 *宽度* 变化来推动
// 聊天列，而不是遮盖它。
const EASE = 'ease-[cubic-bezier(0.16,1,0.3,1)]'
// 440px 对文档/代码/表格这类内容来说偏窄——参考 Claude.ai/ChatGPT 这类
// 产品的画布式侧栏，随视口变宽而分级加宽，大屏幕上不会显得比聊天列
// 还局促。
const PANEL_WIDTH = 'md:w-[480px] lg:w-[560px] xl:w-[640px]'

// blocks/target/collapsed 都直接从各自的 store 订阅——不再需要
// Console.tsx 转发 props。
export function PreviewPanel() {
  const blocks = useConsoleStore((s) => s.blocks)
  const target = usePanelStore((s) => s.target)
  const collapsed = usePanelStore((s) => s.collapsed)
  const close = usePanelStore((s) => s.close)

  // 每次渲染都实时查找——绝不是保存的快照。运行中工具的 block 会随着
  // 输出到达而原地变化（见 store/consoleStore.ts 的 finishTool）；如果
  // 这里保存的是面板打开那一刻的副本，用户看到的就会是一份冻结的快照，
  // 而不是实时结果。
  const toolBlock =
    target?.kind === 'tool' ? (blocks.find((b) => b.kind === 'tool' && b.id === target.id) as
        | Extract<Block, { kind: 'tool' }>
        | undefined)
      : undefined
  const artifactBlock =
    target?.kind === 'artifact'
      ? (blocks.find((b) => b.kind === 'artifact' && b.id === target.id) as Extract<Block, { kind: 'artifact' }> | undefined)
      : undefined

  const artifactSource = useMemo(
    () =>
      artifactBlock
        ? { name: artifactBlock.name, mimeType: artifactBlock.mimeType, resolveUrl: () => getArtifactRawUrl(artifactBlock.id) }
        : null,
    [artifactBlock],
  )

  const documentTarget = target?.kind === 'document' ? target : undefined

  const meta = toolBlock ? TOOL_META[toolBlock.name] : undefined
  const HeaderIcon = toolBlock ? meta?.icon ?? Terminal : documentTarget ? FileText : FileIcon
  const title = toolBlock ? meta?.label ?? toolBlock.name : documentTarget ? documentTarget.name : artifactBlock?.name ?? ''
  const subtitle = toolBlock ? toolSummary(toolBlock.name, toolBlock.args) : undefined

  return (
    <>
      {/* 仅移动端使用的遮罩层，处理方式与 Sidebar 的背景遮罩相同——始终
          挂载，这样关闭时也能播放淡出动画，而不是只有打开时才有效果。 */}
      <div
        aria-hidden
        onClick={close}
        className={cn(
          `fixed inset-0 z-30 bg-black/40 transition-opacity duration-300 md:hidden ${EASE}`,
          collapsed ? 'pointer-events-none opacity-0' : 'opacity-100',
        )}
      />
      <aside
        className={cn(
          `flex shrink-0 flex-col overflow-hidden border-l bg-card text-foreground transition-transform duration-300 ${EASE}`,
          // max-w-md 是给移动端 w-[88vw] 兜底用的，没有 md: 前缀所以本来
          // 会一直生效——桌面端 PANEL_WIDTH 想要的宽度只要超过 28rem
          // （448px）就会被这个上限悄悄截断，440px 的旧值恰好压线没触发。
          // md:max-w-none 让桌面端的宽度完全由 PANEL_WIDTH 决定。
          'fixed inset-y-0 right-0 z-40 w-[88vw] max-w-md md:max-w-none',
          collapsed ? 'translate-x-full' : 'translate-x-0',
          `md:static md:z-auto md:translate-x-0 md:transition-[width] md:duration-300 ${EASE}`,
          collapsed ? 'md:w-0 md:border-l-0' : PANEL_WIDTH,
        )}
      >
        <div className="flex min-w-0 items-center gap-2 border-b px-4 py-3">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <HeaderIcon className="size-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{title}</div>
            {subtitle && <div className="truncate font-mono text-xs text-muted-foreground">{subtitle}</div>}
          </div>
          {toolBlock &&
            (toolBlock.status === 'running' ? (
              <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
            ) : (
              <CheckCircle2 className="size-4 shrink-0 text-primary" />
            ))}
          <Button variant="ghost" size="icon-sm" onClick={close} aria-label="关闭面板">
            <X className="size-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {toolBlock && <ToolDetail block={toolBlock} />}
          {artifactSource && <FilePreview source={artifactSource} />}
          {documentTarget && <Markdown text={documentTarget.content} />}
          {!toolBlock && !artifactSource && !documentTarget && (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <Inbox className="size-4" />
              </div>
              <p className="max-w-[15rem] text-sm text-muted-foreground">内容已不在当前会话中，可能是切换了会话。</p>
            </div>
          )}
        </div>
      </aside>
    </>
  )
}

function ToolDetail({ block }: { block: Extract<Block, { kind: 'tool' }> }) {
  const ResultComponent = getToolResultComponent(block.name)
  return <ResultComponent block={block} variant="full" />
}
