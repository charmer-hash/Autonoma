import { get } from 'lodash-es'
import { cn } from '@autonoma/ui/lib/utils'
import type { Block } from '@/types/blocks'
import { parseResult } from '@/lib/format'

export function RunCommandResult({ block }: { block: Extract<Block, { kind: 'tool' }> }) {
  const result = parseResult<{ exitCode: number; stdout: string; stderr: string }>(block.result)
  return (
    <div className="space-y-2">
      <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">
        $ {String(get(block.args, 'command', ''))}
      </pre>
      {result && (
        <>
          <span
            className={cn(
              'inline-block rounded px-1.5 py-0.5 text-[10px] font-medium',
              result.exitCode === 0
                ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                : 'bg-destructive/15 text-destructive',
            )}
          >
退出码 {result.exitCode}
          </span>
          {result.stdout && (
            <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
              {result.stdout}
            </pre>
          )}
          {result.stderr && (
            <pre className="overflow-x-auto rounded-md bg-destructive/10 p-2 font-mono text-xs whitespace-pre-wrap text-destructive">
              {result.stderr}
            </pre>
          )}
        </>
      )}
    </div>
  )
}
