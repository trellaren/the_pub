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

/**
 * Electron wraps a handler's error as "Error invoking remote method 'x':
 * Error: <message>", and a schema rejection arrives as a ZodError whose message
 * is its issue list as JSON. Neither is something to show an author verbatim.
 */
const REMOTE_PREFIX = /^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/

export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const message = raw.replace(REMOTE_PREFIX, '')
  return describeSchemaFailure(message) ?? message
}

function describeSchemaFailure(message: string): string | null {
  if (!message.trimStart().startsWith('[')) return null
  try {
    const issues: unknown = JSON.parse(message)
    if (!Array.isArray(issues) || issues.length === 0) return null
    const first = issues[0] as { message?: unknown; path?: unknown; code?: unknown }
    if (typeof first.message !== 'string' || typeof first.code !== 'string') return null
    const field = Array.isArray(first.path) && first.path.length > 0 ? ` (${first.path.join('.')})` : ''
    return `The request was not valid: ${first.message}${field}.`
  } catch {
    return null
  }
}

/**
 * Transient messages shown in the corner of the window.
 *
 * These carry a severity because not everything worth saying is a failure: an
 * import that succeeded but left the footnotes behind has to be reported, and
 * saying so in the same red box used for errors would tell the author something
 * broke when nothing did.
 */
export interface Notice {
  message: string
  kind: 'error' | 'info'
}

type NoticeListener = (notice: Notice) => void
const noticeListeners = new Set<NoticeListener>()

export function onNotice(listener: NoticeListener): () => void {
  noticeListeners.add(listener)
  return () => noticeListeners.delete(listener)
}

export function reportError(message: string): void {
  for (const listener of noticeListeners) listener({ message, kind: 'error' })
}

export function reportNotice(message: string): void {
  for (const listener of noticeListeners) listener({ message, kind: 'info' })
}
