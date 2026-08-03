import { cn } from '@autonoma/ui/lib/utils'
import type { ToolResultProps } from '@/lib/tool-meta'
import { prettyJson } from '@/lib/format'

export function JsonFallbackResult({ block, variant = 'compact' }: ToolResultProps) {
  const full = variant === 'full'
  return (
    <div className="space-y-2">
      <div className="relative">
        <pre className={cn('overflow-auto rounded-md bg-muted p-2 font-mono text-xs', !full && 'max-h-64')}>
          {prettyJson(block.args)}
        </pre>
        {!full && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 rounded-b-md bg-gradient-to-t from-muted to-transparent" />
        )}
      </div>
      {block.result !== undefined && (
        <div className="relative">
          <pre className={cn('overflow-auto rounded-md bg-muted p-2 font-mono text-xs', !full && 'max-h-64')}>
            {prettyJson(block.result)}
          </pre>
          {!full && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 rounded-b-md bg-gradient-to-t from-muted to-transparent" />
          )}
        </div>
      )}
    </div>
  )
}
