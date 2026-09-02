import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, Menu, shell, type MenuItemConstructorOptions, type WebContents } from 'electron'
import type { IpcEventChannel, IpcEvent } from '../../shared/ipc/contract.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const PRELOAD = path.join(dirname, '../preload/index.cjs')

/** Grace period for a renderer to flush unsaved work before its window closes anyway. */
const CLOSE_FLUSH_TIMEOUT_MS = 4000

/**
 * The Raven theme's own background, so a window opens in the app's colour
 * rather than flashing something else before the renderer paints.
 */
const BACKGROUND = '#0b0d10'

/**
 * The window icon, for the places a platform reads one off a running process
 * rather than off the installed application: a development run, and Linux.
 *
 * Absent from a packaged build, where `resources/` is build input rather than
 * shipped content — there the icon is already inside the executable (Windows,
 * macOS) or in the `.desktop` entry (Linux), both put there by
 * electron-builder from this same file.
 */
const ICON = ((): string | null => {
  const candidate = path.join(dirname, '../../resources/icon.png')
  return fs.existsSync(candidate) ? candidate : null
})()

/**
 * No frame: the title bar is the app's own, holding the menu, the search field
 * and the window buttons the way an IDE does.
 *
 * macOS keeps its traffic lights, inset, because they are what a Mac user
 * reaches for and nothing about them belongs to the app; the title bar leaves
 * room for them instead of drawing buttons of its own. Popouts are not given
 * this — they carry no title bar of their own, so a frameless one would have
 * nothing to drag.
 */
const CHROME_OPTIONS: Electron.BrowserWindowConstructorOptions =
  process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : { frame: false }

function chromeStateOf(window: BrowserWindow): { maximized: boolean; fullScreen: boolean } {
  return { maximized: window.isMaximized(), fullScreen: window.isFullScreen() }
}

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
  private onSpellcheckAddWord?: (ownerId: number, word: string) => void
  private baseUrl: string | null = null

  setProjectWindowHandler(handler: (window: BrowserWindow) => void): void {
    this.onCreateProject = handler
  }

  /**
   * Called when someone chooses "Add to Dictionary" from the native
   * right-click menu, so the word is written into the project's own
   * `.thepub/dictionary.json` rather than only into this run's in-memory
   * Electron session.
   */
  setSpellcheckAddWordHandler(handler: (ownerId: number, word: string) => void): void {
    this.onSpellcheckAddWord = handler
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
      title: 'Quoth',
      show: false,
      ...CHROME_OPTIONS,
      ...(ICON ? { icon: ICON } : {}),
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    })

    /*
     * The application menu stays registered — it is what makes the accelerators
     * work, and the keybindings editor is written against it — but on the
     * platforms where it would be drawn inside the window it is not shown,
     * because the title bar draws that menu itself now.
     */
    if (process.platform !== 'darwin') window.setMenuBarVisibility(false)

    this.records.set(window.id, { window, ownerId: window.id, closeConfirmed: false })
    this.hardenWebContents(window.webContents, window.id)
    window.once('ready-to-show', () => window.show())
    window.on('close', (event) => this.handleClose(window, event))
    window.on('closed', () => this.records.delete(window.id))
    // The buttons follow the window, not the other way round: it can be
    // maximized or unmaximized by the window manager, a double-click on the
    // drag area, or a keyboard shortcut, none of which go through the title bar.
    const announceChrome = (): void => {
      this.send(window.webContents, 'window:chromeChanged', chromeStateOf(window))
    }
    window.on('maximize', announceChrome)
    window.on('unmaximize', announceChrome)
    window.on('enter-full-screen', announceChrome)
    window.on('leave-full-screen', announceChrome)

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
      // Both halves matter. The path alone would let any host serving a
      // `/popout.html` inherit the opener's webPreferences — the preload bridge
      // included — and a manuscript's links are written by the author and by
      // the AI, so `target="_blank"` to such a URL is a real route in.
      if (this.isInternalUrl(url) && isPopoutUrl(url)) {
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

    // The native right-click spellcheck menu: Electron hands us the misspelled
    // word and Chromium's own suggestions on `params`, so this is wiring, not
    // a spellchecker of our own.
    contents.on('context-menu', (_event, params) => {
      if (!params.misspelledWord) return
      const template: MenuItemConstructorOptions[] = params.dictionarySuggestions.map(
        (suggestion) => ({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) })
      )
      if (template.length > 0) template.push({ type: 'separator' })
      template.push({
        label: 'Add to Dictionary',
        click: () => {
          contents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
          this.onSpellcheckAddWord?.(ownerId, params.misspelledWord)
        }
      })
      Menu.buildFromTemplate(template).popup({ window: BrowserWindow.fromWebContents(contents) ?? undefined })
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

  /*
   * The window buttons the frame used to draw.
   *
   * Each acts on the window the click came from, not on the focused one: a
   * request can arrive while another window is in front, and a close aimed at
   * the wrong window would take unsaved work with it. A window this manager has
   * forgotten (already closed) is a no-op rather than a crash, because a click
   * can land in the gap between the close and the window going away.
   */
  minimize(contents: WebContents): void {
    this.recordFor(contents)?.window.minimize()
  }

  toggleMaximize(contents: WebContents): { maximized: boolean; fullScreen: boolean } {
    const window = this.recordFor(contents)?.window
    if (!window || window.isDestroyed()) return { maximized: false, fullScreen: false }
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
    return chromeStateOf(window)
  }

  /** The × — the same path the frame's took, unsaved-work flush and all. */
  requestClose(contents: WebContents): void {
    const window = this.recordFor(contents)?.window
    if (window && !window.isDestroyed()) window.close()
  }

  chromeState(contents: WebContents): { maximized: boolean; fullScreen: boolean } {
    const window = this.recordFor(contents)?.window
    return window && !window.isDestroyed()
      ? chromeStateOf(window)
      : { maximized: false, fullScreen: false }
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

/**
 * Dockview opens popout groups at `popout.html`.
 *
 * The origin is checked separately by the caller — this only answers "is that
 * the popout page", and on its own it is not an authorisation.
 */
function isPopoutUrl(url: string): boolean {
  try {
    return new URL(url).pathname.endsWith('/popout.html')
  } catch {
    return false
  }
}
