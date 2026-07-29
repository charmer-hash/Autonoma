import type { Block } from '@/types/blocks'
import { prettyJson } from '@/lib/format'

export function JsonFallbackResult({ block }: { block: Extract<Block, { kind: 'tool' }> }) {
  return (
    <div className="space-y-2">
      <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">{prettyJson(block.args)}</pre>
      {block.result !== undefined && (
        <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">{prettyJson(block.result)}</pre>
      )}
    </div>
  )
}
