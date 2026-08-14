import { contextBridge, ipcRenderer } from 'electron'
import { INVOKE_CHANNELS, EVENT_CHANNELS } from '../shared/ipc/channels.js'
import type { InvokeChannelName, EventChannelName } from '../shared/ipc/channels.js'

const invokeAllowed = new Set<string>(INVOKE_CHANNELS)
const eventAllowed = new Set<string>(EVENT_CHANNELS)

/**
 * The entire renderer→main surface. Deliberately not a generic `ipcRenderer`
 * passthrough: only channels declared in the contract can be reached, and the
 * main process re-validates every payload regardless.
 */
const api = {
  invoke(channel: InvokeChannelName, payload?: unknown): Promise<unknown> {
    if (!invokeAllowed.has(channel)) {
      return Promise.reject(new Error(`Blocked IPC channel: ${channel}`))
    }
    return ipcRenderer.invoke(channel, payload ?? {})
  },
  on(channel: EventChannelName, listener: (payload: unknown) => void): () => void {
    if (!eventAllowed.has(channel)) throw new Error(`Blocked IPC event: ${channel}`)
    const wrapped = (_event: unknown, payload: unknown): void => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.off(channel, wrapped)
  }
}

contextBridge.exposeInMainWorld('pub', api)

export type PubBridge = typeof api
