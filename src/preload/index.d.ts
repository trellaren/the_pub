import type { IpcInvokeChannel, IpcEventChannel, IpcReq, IpcRes, IpcEvent } from '../shared/ipc/contract.js'

/**
 * Renderer-facing view of the preload bridge. The generic signatures here are
 * what make `pub.invoke('doc:read', { path })` return a typed `LoadedDocument`.
 */
export interface TypedPubBridge {
  invoke<K extends IpcInvokeChannel>(channel: K, payload: IpcReq<K>): Promise<IpcRes<K>>
  on<K extends IpcEventChannel>(channel: K, listener: (payload: IpcEvent<K>) => void): () => void
}

declare global {
  interface Window {
    pub: TypedPubBridge
  }
}

export {}
