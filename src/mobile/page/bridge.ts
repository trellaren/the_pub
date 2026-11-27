import { INVOKE_CHANNELS, EVENT_CHANNELS } from '@shared/ipc/channels.js'
import type { HostInit, HostToPage, PageToHost, ShellRequest } from '../protocol.js'

type Listener = (payload: unknown) => void

export interface Host {
  /** The bytes behind a `pub-asset:` URL, or null if the project it names is not open. */
  asset(url: string): Promise<{ bytes: Uint8Array; mime: string } | null>
}

/**
 * Start the host worker and put the bridge the renderer expects on `window`.
 *
 * This is the preload script's counterpart: the same two functions with the
 * same allow-list, carried by `postMessage` to a worker instead of by Electron
 * IPC to another process.
 */
export function startHost(
  init: HostInit,
  runShell: (request: ShellRequest) => Promise<unknown>
): Promise<Host> {
  const worker = new Worker(new URL('../host/worker.ts', import.meta.url), { type: 'module' })
  const send = (message: PageToHost): void => worker.postMessage(message)

  const invokeAllowed = new Set<string>(INVOKE_CHANNELS)
  const eventAllowed = new Set<string>(EVENT_CHANNELS)
  const listeners = new Map<string, Set<Listener>>()
  const calls = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const assets = new Map<number, (asset: { bytes: Uint8Array; mime: string } | null) => void>()
  let nextId = 1

  window.pub = {
    invoke(channel: string, payload?: unknown): Promise<unknown> {
      if (!invokeAllowed.has(channel)) return Promise.reject(new Error(`Blocked IPC channel: ${channel}`))
      const id = nextId++
      return new Promise((resolve, reject) => {
        calls.set(id, { resolve, reject })
        send({ type: 'invoke', id, channel, payload: payload ?? {} })
      })
    },
    on(channel: string, listener: Listener): () => void {
      if (!eventAllowed.has(channel)) throw new Error(`Blocked IPC event: ${channel}`)
      const set = listeners.get(channel) ?? new Set<Listener>()
      listeners.set(channel, set)
      set.add(listener)
      return () => set.delete(listener)
    }
  } as Window['pub']

  return new Promise<Host>((resolve, reject) => {
    worker.onerror = (event) => reject(new Error(event.message || 'The app could not start.'))
    worker.onmessage = ({ data: message }: MessageEvent<HostToPage>) => {
      switch (message.type) {
        case 'ready':
          resolve({
            asset(url) {
              const id = nextId++
              return new Promise((settle) => {
                assets.set(id, settle)
                send({ type: 'asset', id, url })
              })
            }
          })
          return
        case 'failed':
          reject(new Error(message.error))
          return
        case 'result': {
          const call = calls.get(message.id)
          calls.delete(message.id)
          if (message.ok) call?.resolve(message.value)
          else call?.reject(new Error(message.error))
          return
        }
        case 'event':
          for (const listener of listeners.get(message.channel) ?? []) listener(message.payload)
          return
        case 'assetResult': {
          const settle = assets.get(message.id)
          assets.delete(message.id)
          settle?.(message.bytes ? { bytes: message.bytes, mime: message.mime } : null)
          return
        }
        case 'shell':
          runShell(message.request).then(
            (value) => send({ type: 'shellResult', id: message.id, ok: true, value }),
            (error: unknown) =>
              send({
                type: 'shellResult',
                id: message.id,
                ok: false,
                error: error instanceof Error ? error.message : String(error)
              })
          )
      }
    }
    send({ type: 'init', init })
  })
}
