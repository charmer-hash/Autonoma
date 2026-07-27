import { useState } from 'react'
import { Button } from '@autonoma/ui/components/button'
import { Textarea } from '@autonoma/ui/components/textarea'
import { runAgent } from '@/lib/agent-events'

type Block =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; text: string }
  | { kind: 'error'; text: string }

function App() {
  const [task, setTask] = useState('')
  const [blocks, setBlocks] = useState<Block[]>([])
  const [running, setRunning] = useState(false)

  function appendText(delta: string) {
    setBlocks((prev) => {
      const last = prev[prev.length - 1]
      if (last?.kind === 'text') {
        return [...prev.slice(0, -1), { kind: 'text', text: last.text + delta }]
      }
      return [...prev, { kind: 'text', text: delta }]
    })
  }

  function appendLine(kind: 'tool' | 'error', text: string) {
    setBlocks((prev) => [...prev, { kind, text }])
  }

  async function run() {
    const currentTask = task.trim()
    if (!currentTask || running) return

    setBlocks([])
    setRunning(true)
    try {
      for await (const event of runAgent(currentTask)) {
        switch (event.type) {
          case 'text_delta':
            appendText(event.delta)
            break
          case 'tool_call':
            appendLine('tool', `🔧 ${event.name}(${JSON.stringify(event.args)})`)
            break
          case 'tool_result':
            appendLine('tool', `→ ${event.result}`)
            break
          case 'error':
            appendLine('error', event.message)
            break
          case 'done':
            break
        }
      }
    } catch (err) {
      appendLine('error', err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="mx-auto flex min-h-svh max-w-2xl flex-col gap-4 p-6">
      <h1 className="text-2xl font-semibold">Autonoma</h1>
      <p className="text-muted-foreground">
        Describe a coding task and watch the agent work in a sandbox.
      </p>

      <Textarea
        value={task}
        onChange={(e) => setTask(e.target.value)}
        placeholder='e.g. "Write a Python script that prints the first 10 Fibonacci numbers, then run it."'
        disabled={running}
        rows={3}
      />
      <Button onClick={run} disabled={running || !task.trim()}>
        {running ? 'Running…' : 'Run'}
      </Button>

      <div className="flex-1 space-y-2 overflow-y-auto rounded-lg border p-4 font-mono text-sm">
        {blocks.length === 0 && <p className="text-muted-foreground">No output yet.</p>}
        {blocks.map((block, i) => (
          <div
            key={i}
            className={
              block.kind === 'error'
                ? 'rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-destructive'
                : block.kind === 'tool'
                  ? 'rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1'
                  : 'whitespace-pre-wrap'
            }
          >
            {block.text}
          </div>
        ))}
      </div>
    </div>
  )
}

export default App
