import { get } from 'lodash-es'
import type { Block } from '@/types/blocks'

export function WriteFileResult({ block }: { block: Extract<Block, { kind: 'tool' }> }) {
  return (
    <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
      {String(get(block.args, 'content', ''))}
    </pre>
  )
}
