/**
 * What the page and the host worker say to each other.
 *
 * The page owns everything that needs a DOM or a native plugin; the worker
 * owns everything the desktop main process owns. `invoke`/`event` carry the
 * same IPC contract Electron does. `shell` runs the other way: the host asking
 * the page for something only a page can do.
 */

export interface HostInit {
  /** Inside the Capacitor shell, as opposed to a plain browser tab. */
  native: boolean
  locale: string
  version: string
  /** Where Microsoft sends the browser back to after a OneDrive sign-in. */
  redirectUri: string
}

export interface PickedFile {
  name: string
  bytes: Uint8Array
}

export interface HttpRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: string | Uint8Array
  /** False when the caller has to see a redirect itself rather than have it followed. */
  followRedirects: boolean
}

export interface HttpResponse {
  status: number
  headers: Record<string, string>
  body: Uint8Array
}

export type EditRole = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'

export type ShellRequest =
  | { op: 'messageBox'; message: string; detail?: string; buttons: string[]; cancelId: number }
  | { op: 'pickFiles'; title: string; extensions: string[]; multiple: boolean }
  | { op: 'pickFolder'; title: string; purpose: 'open' | 'create'; existing: string[] }
  | { op: 'saveFile'; name: string; bytes: Uint8Array }
  | { op: 'openExternal'; url: string }
  | { op: 'authSession'; url: string; redirectUri: string }
  | { op: 'authCancel' }
  | { op: 'edit'; role: EditRole }
  | { op: 'zoom'; level: number }
  | { op: 'setTitle'; title: string }
  | { op: 'print'; html: string }
  | { op: 'http'; request: HttpRequest }

export interface ShellResults {
  messageBox: { response: number }
  pickFiles: PickedFile[] | null
  pickFolder: { name: string } | null
  saveFile: null
  openExternal: null
  authSession: { url: string }
  authCancel: null
  edit: null
  zoom: null
  setTitle: null
  print: null
  http: HttpResponse
}

export type ShellResult<R extends ShellRequest> = ShellResults[R['op']]

export type PageToHost =
  | { type: 'init'; init: HostInit }
  | { type: 'invoke'; id: number; channel: string; payload: unknown }
  | { type: 'asset'; id: number; url: string }
  | { type: 'shellResult'; id: number; ok: true; value: unknown }
  | { type: 'shellResult'; id: number; ok: false; error: string }

export type HostToPage =
  | { type: 'ready' }
  | { type: 'failed'; error: string }
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; error: string }
  | { type: 'event'; channel: string; payload: unknown }
  | { type: 'assetResult'; id: number; bytes: Uint8Array | null; mime: string }
  | { type: 'shell'; id: number; request: ShellRequest }
