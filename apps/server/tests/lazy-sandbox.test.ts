import assert from 'node:assert/strict'
import test from 'node:test'
import type { Sandbox } from 'e2b'
import { createLazySandbox } from '../src/agent/lazy-sandbox.js'
import { createSandboxTools } from '../src/agent/tools/sandbox.js'

test('registering sandbox tools does not initialize a sandbox', () => {
  const lazy = createLazySandbox(async () => { throw new Error('unexpected initialization') })
  assert.equal(createSandboxTools(lazy.get).tools.length, 2)
  assert.equal(lazy.peek(), undefined)
})

test('concurrent consumers share initialization and subsequent tools reuse it', async () => {
  let initialized = 0
  const operations: string[] = []
  const sandbox = {
    files: { write: async () => { operations.push('write') } },
    commands: { run: async () => { operations.push('run'); return { exitCode: 0, stdout: 'ok', stderr: '' } } },
  } as unknown as Sandbox
  const lazy = createLazySandbox(async () => { initialized++; return sandbox })
  const results = await Promise.all([lazy.get(), lazy.get()])
  assert.deepEqual(results, [sandbox, sandbox])
  const { toolHandlers } = createSandboxTools(lazy.get)
  await toolHandlers.write_file({ path: 'example.txt', content: 'hello' })
  assert.equal(JSON.parse(await toolHandlers.run_command({ command: 'cat example.txt' })).stdout, 'ok')
  assert.deepEqual(operations, ['write', 'run'])
  assert.equal(initialized, 1)
  assert.equal(lazy.peek(), sandbox)
})

test('failed initialization is shared and can be retried by a later tool', async () => {
  let initialized = 0
  const sandbox = {} as Sandbox
  const lazy = createLazySandbox(async () => {
    if (++initialized === 1) throw new Error('unavailable')
    return sandbox
  })
  const results = await Promise.allSettled([lazy.get(), lazy.get()])
  assert.ok(results.every((result) => result.status === 'rejected'))
  assert.equal(initialized, 1)
  assert.equal(lazy.peek(), undefined)
  assert.equal(await lazy.get(), sandbox)
  assert.equal(initialized, 2)
})
