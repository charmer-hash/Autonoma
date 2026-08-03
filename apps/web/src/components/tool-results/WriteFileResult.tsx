import { get } from 'lodash-es'
import { cn } from '@autonoma/ui/lib/utils'
import type { ToolResultProps } from '@/lib/tool-meta'

export function WriteFileResult({ block, variant = 'compact' }: ToolResultProps) {
  const full = variant === 'full'
  return (
    <div className="relative">
      <pre className={cn('overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap', !full && 'max-h-64')}>
        {String(get(block.args, 'content', ''))}
      </pre>
      {!full && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 rounded-b-md bg-gradient-to-t from-muted to-transparent" />
      )}
    </div>
  )
}
