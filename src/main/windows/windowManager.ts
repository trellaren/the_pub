import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, shell, type WebContents } from 'electron'
import type { IpcEventChannel, IpcEvent } from '../../shared/ipc/contract.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const PRELOAD = path.join(dirname, '../preload/index.cjs')

/** Grace period for a renderer to flush unsaved work before its window closes anyway. */
const CLOSE_FLUSH_TIMEOUT_MS = 4000

const BACKGROUND = '#12100e'

interface WindowRecord {
  window: BrowserWindow
  /** Popout windows share their opener's project session. */
  ownerId: number
  closeConfirmed: boolean
}

/**
 * Owns every BrowserWindow.
 *
 * There are two kinds. A *project window* is a top-level window with its own
 * project session. A *popout* is a dockview group torn off into its own OS
 * window: it is opened with same-origin `window.open` and inherits the opener's
 * web preferences, so it shares that renderer's JS heap. Panes dragged into one
 * keep the same editor instances, stores and undo history, with no state
 * syncing at all — which is why the renderer is served over loopback HTTP
 * rather than `file://`, whose opaque origin cannot support this.
 */
export class WindowManager {
  private records = new Map<number, WindowRecord>()
  private onCreateProject?: (window: BrowserWindow) => void
  private baseUrl: string | null = null

  setProjectWindowHandler(handler: (window: BrowserWindow) => void): void {
    this.onCreateProject = handler
  }

  /** Where the renderer is served from: the vite dev server, or the loopback server when packaged. */
  setRendererBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl
  }

  /** True for URLs belonging to the app's own renderer origin. */
  private isInternalUrl(url: string): boolean {
    if (!this.baseUrl) return false
    try {
      return new URL(url).origin === new URL(this.baseUrl).origin
    } catch {
      return false
    }
  }

  createProjectWindow(): BrowserWindow {
    const window = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 720,
      minHeight: 480,
      backgroundColor: BACKGROUND,
      title: 'The Pub',
      show: false,
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    })

    this.records.set(window.id, { window, ownerId: window.id, closeConfirmed: false })
    this.hardenWebContents(window.webContents, window.id)
    window.once('ready-to-show', () => window.show())
    window.on('close', (event) => this.handleClose(window, event))
    window.on('closed', () => this.records.delete(window.id))

    void this.loadRenderer(window)
    this.onCreateProject?.(window)
    return window
  }

  private async loadRenderer(window: BrowserWindow): Promise<void> {
    if (!this.baseUrl) throw new Error('Renderer base URL was not configured')
    await window.loadURL(`${this.baseUrl}/index.html`)
  }

  /**
   * Apply the navigation and window-opening policy.
   *
   * Only dockview popouts may open a window, and only to our own popout page;
   * anything else is handed to the OS browser rather than opened in-app, so a
   * dropped or clicked link can never replace the app with a remote page.
   */
  private hardenWebContents(contents: WebContents, ownerId: number): void {
    contents.setWindowOpenHandler(({ url }) => {
      if (isPopoutUrl(url)) {
        // Only cosmetic options are overridden. The child deliberately inherits
        // the opener's webPreferences: giving it its own would put it in a
        // separate context, and a torn-off pane has to keep sharing the
        // opener's stores and editor instances.
        return {
          action: 'allow',
          overrideBrowserWindowOptions: { backgroundColor: BACKGROUND, autoHideMenuBar: true }
        }
      }
      if (/^https?:/.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })

    contents.on('will-navigate', (event, url) => {
      // Navigation within the app's own origin is legitimate — a popout window
      // reaching its page does exactly this. Anything off-origin is a link the
      // user followed, and belongs in their browser rather than in the app.
      if (this.isInternalUrl(url)) return
      event.preventDefault()
      if (/^https?:/.test(url)) void shell.openExternal(url)
    })

    contents.on('did-create-window', (child) => {
      // Popouts inherit the opener's session so their panels resolve documents
      // against the same project.
      this.records.set(child.id, { window: child, ownerId, closeConfirmed: true })
      this.hardenWebContents(child.webContents, ownerId)
      child.on('closed', () => this.records.delete(child.id))
    })
  }

  /**
   * Give the renderer a chance to flush debounced saves before the window goes
   * away, but never let an unresponsive renderer make the window unclosable.
   */
  private handleClose(window: BrowserWindow, event: Electron.Event): void {
    const record = this.records.get(window.id)
    if (!record || record.closeConfirmed) return
    event.preventDefault()
    record.closeConfirmed = false
    this.send(window.webContents, 'window:requestClose', {})
    setTimeout(() => {
      if (!window.isDestroyed()) this.confirmClose(window.webContents)
    }, CLOSE_FLUSH_TIMEOUT_MS)
  }

  /** Called when the renderer reports its saves are flushed (or the timeout fires). */
  confirmClose(contents: WebContents): void {
    const record = this.recordFor(contents)
    if (!record || record.window.isDestroyed()) return
    record.closeConfirmed = true
    record.window.close()
  }

  /** The project-owning window for any webContents, resolving popouts to their opener. */
  ownerWindowId(contents: WebContents): number | null {
    return this.recordFor(contents)?.ownerId ?? null
  }

  private recordFor(contents: WebContents): WindowRecord | undefined {
    const direct = this.records.get(BrowserWindow.fromWebContents(contents)?.id ?? -1)
    if (direct) return direct
    for (const record of this.records.values()) {
      if (record.window.webContents.id === contents.id) return record
    }
    return undefined
  }

  send<K extends IpcEventChannel>(contents: WebContents, channel: K, payload: IpcEvent<K>): void {
    if (!contents.isDestroyed()) contents.send(channel, payload)
  }

  /** Send to a project window and every popout that belongs to it. */
  sendToSession<K extends IpcEventChannel>(ownerId: number, channel: K, payload: IpcEvent<K>): void {
    for (const record of this.records.values()) {
      if (record.ownerId === ownerId) this.send(record.window.webContents, channel, payload)
    }
  }

  broadcast<K extends IpcEventChannel>(channel: K, payload: IpcEvent<K>): void {
    for (const record of this.records.values()) this.send(record.window.webContents, channel, payload)
  }

  windowsForSession(ownerId: number): BrowserWindow[] {
    return [...this.records.values()].filter((r) => r.ownerId === ownerId).map((r) => r.window)
  }
}

/** Dockview opens popout groups at our own `popout.html`, same-origin with the app. */
function isPopoutUrl(url: string): boolean {
  try {
    return new URL(url).pathname.endsWith('/popout.html')
  } catch {
    return false
  }
}
