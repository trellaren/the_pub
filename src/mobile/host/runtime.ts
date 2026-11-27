import type { MobileFs } from './mobileFs.js'
import type { HostInit, HostToPage, ShellRequest, ShellResult } from '../protocol.js'

/**
 * What the shims reach for. They are imported by desktop code as if they were
 * `node:fs` or `electron`, so they cannot be handed their dependencies — the
 * host fills this in before any of that code runs.
 */
interface Runtime {
  fs: MobileFs
  init: HostInit
  post: (message: HostToPage, transfer?: Transferable[]) => void
  storageKey: Uint8Array
}

let runtime: Runtime | null = null

export function installRuntime(value: Runtime): void {
  runtime = value
}

export function current(): Runtime {
  if (!runtime) throw new Error('The host has not finished starting')
  return runtime
}

let nextShellId = 1
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

/** Ask the page to do something only a page can: draw a dialog, open a browser, pick a file. */
export function shell<R extends ShellRequest>(request: R): Promise<ShellResult<R>> {
  const id = nextShellId++
  return new Promise<ShellResult<R>>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
    current().post({ type: 'shell', id, request })
  })
}

export function settleShell(id: number, outcome: { ok: true; value: unknown } | { ok: false; error: string }): void {
  const waiting = pending.get(id)
  if (!waiting) return
  pending.delete(id)
  if (outcome.ok) waiting.resolve(outcome.value)
  else waiting.reject(new Error(outcome.error))
}
