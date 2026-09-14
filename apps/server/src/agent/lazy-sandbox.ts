import type { Sandbox } from 'e2b'

export type GetSandbox = () => Promise<Sandbox>

// Share initialization across tools in one run. A later tool may retry a failed initialization.
export function createLazySandbox(initialize: GetSandbox) {
  let pending: Promise<Sandbox> | undefined
  let instance: Sandbox | undefined
  return {
    get: (): Promise<Sandbox> => {
      pending ??= Promise.resolve().then(initialize).then((sandbox) => {
        instance = sandbox
        return sandbox
      }).catch((error) => {
        pending = undefined
        throw error
      })
      return pending
    },
    peek: () => instance,
  }
}
