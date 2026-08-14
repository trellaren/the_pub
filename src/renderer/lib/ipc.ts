import type { IpcInvokeChannel, IpcEventChannel, IpcReq, IpcRes, IpcEvent } from '@shared/ipc/contract.js'

/**
 * The bridge is installed by the preload script. If that failed to load, every
 * call site would otherwise fail with an unreadable "cannot read property of
 * undefined" far from the cause.
 */
function bridge(): Window['pub'] {
  if (!window.pub) {
    throw new Error('The preload bridge is unavailable — the preload script failed to load')
  }
  return window.pub
}

/** Typed wrapper over the preload bridge. */
export function invoke<K extends IpcInvokeChannel>(channel: K, payload: IpcReq<K>): Promise<IpcRes<K>> {
  return bridge().invoke(channel, payload)
}

export function on<K extends IpcEventChannel>(
  channel: K,
  listener: (payload: IpcEvent<K>) => void
): () => void {
  return bridge().on(channel, listener)
}

/** Surface an operation's failure without letting it take the window down. */
export async function attempt<T>(operation: Promise<T>, context: string): Promise<T | null> {
  try {
    return await operation
  } catch (error) {
    console.error(`${context}:`, error)
    reportError(`${context}: ${errorMessage(error)}`)
    return null
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

type ErrorListener = (message: string) => void
const errorListeners = new Set<ErrorListener>()

export function onError(listener: ErrorListener): () => void {
  errorListeners.add(listener)
  return () => errorListeners.delete(listener)
}

export function reportError(message: string): void {
  for (const listener of errorListeners) listener(message)
}
