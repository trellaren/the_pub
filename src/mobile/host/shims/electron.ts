import { Buffer } from 'buffer'
import { gcm } from '@noble/ciphers/aes.js'
import { current, shell as askPage } from '../runtime.js'
import type { EditRole } from '../../protocol.js'

/**
 * The slice of Electron the desktop services and handlers call, answered by a
 * WebView. Each piece keeps Electron's own shape so that code is shared
 * unchanged; what a page cannot do is passed to the page that hosts this
 * worker, and what a phone has no notion of — a second window, a trash — says
 * so the way Electron would on a system without one.
 */

export const USER_DATA = '/userData'
export const DOCUMENTS = '/Documents'
export const TEMP = '/tmp'
export const EXPORTS = '/exports'

export const app = {
  isPackaged: true,
  getPath(name: string): string {
    if (name === 'userData') return USER_DATA
    if (name === 'temp') return TEMP
    return DOCUMENTS
  },
  getVersion: (): string => current().init.version,
  getLocale: (): string => current().init.locale,
  getAppPath: (): string => '/',
  quit(): void {}
}

const NONCE_BYTES = 12

export const safeStorage = {
  isEncryptionAvailable: (): boolean => true,
  encryptString(plain: string): Buffer {
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
    const sealed = gcm(current().storageKey, nonce).encrypt(new TextEncoder().encode(plain))
    return Buffer.concat([nonce, sealed])
  },
  decryptString(sealed: Uint8Array): string {
    const nonce = sealed.subarray(0, NONCE_BYTES)
    return new TextDecoder().decode(gcm(current().storageKey, nonce).decrypt(sealed.subarray(NONCE_BYTES)))
  }
}

export const shell = {
  async openExternal(url: string): Promise<void> {
    await askPage({ op: 'openExternal', url })
  },
  /** Rejects, as it does on a desktop with no trash: the caller then deletes outright. */
  async trashItem(_path: string): Promise<void> {
    throw new Error('There is no trash on this device.')
  },
  showItemInFolder(_path: string): void {}
}

interface OpenDialogOptions {
  title?: string
  filters?: { name: string; extensions: string[] }[]
  properties?: string[]
}

interface SaveDialogOptions {
  title?: string
  defaultPath?: string
}

interface MessageBoxOptions {
  message: string
  detail?: string
  buttons?: string[]
  cancelId?: number
}

let pickCount = 0

export const dialog = {
  async showMessageBox(_window: unknown, options: MessageBoxOptions): Promise<{ response: number }> {
    const buttons = options.buttons?.length ? options.buttons : ['OK']
    return askPage({
      op: 'messageBox',
      message: options.message,
      detail: options.detail,
      buttons,
      cancelId: options.cancelId ?? buttons.length - 1
    })
  },

  /**
   * A folder here is a project kept on the device, chosen by name; a file is
   * read out of the system picker into temporary storage, so the caller gets
   * the path it expects and reads it the way it always has.
   */
  async showOpenDialog(
    _window: unknown,
    options: OpenDialogOptions
  ): Promise<{ canceled: boolean; filePaths: string[] }> {
    const properties = options.properties ?? []
    const fs = current().fs

    if (properties.includes('openDirectory')) {
      const creating = /^new /i.test(options.title ?? '')
      const picked = await askPage({
        op: 'pickFolder',
        title: options.title ?? 'Open project',
        purpose: creating ? 'create' : 'open',
        existing: fs.readdirSync(DOCUMENTS).filter((name) => fs.statSync(`${DOCUMENTS}/${name}`).isDirectory())
      })
      if (!picked) return { canceled: true, filePaths: [] }
      const folder = `${DOCUMENTS}/${picked.name}`
      fs.mkdirSync(folder, { recursive: true })
      return { canceled: false, filePaths: [folder] }
    }

    const files = await askPage({
      op: 'pickFiles',
      title: options.title ?? 'Choose a file',
      extensions: (options.filters ?? []).flatMap((filter) => filter.extensions).filter((ext) => ext !== '*'),
      multiple: properties.includes('multiSelections')
    })
    if (!files || files.length === 0) return { canceled: true, filePaths: [] }
    // One folder per pick, so two files of the same name chosen a minute apart cannot collide.
    const folder = `${TEMP}/pick-${++pickCount}`
    fs.mkdirSync(folder, { recursive: true })
    return {
      canceled: false,
      filePaths: files.map((file) => {
        const target = `${folder}/${file.name.replace(/[/\\]/g, '_')}`
        fs.writeFileSync(target, file.bytes)
        return target
      })
    }
  },

  /**
   * Nothing is asked here: the caller is handed a path under `EXPORTS`, and
   * the host passes whatever lands there to the share sheet, which is where
   * iOS asks where a file should go.
   */
  async showSaveDialog(
    _window: unknown,
    options: SaveDialogOptions
  ): Promise<{ canceled: boolean; filePath: string }> {
    const name = (options.defaultPath ?? 'Untitled').split(/[/\\]/).pop() || 'Untitled'
    const folder = `${EXPORTS}/${++pickCount}`
    current().fs.mkdirSync(folder, { recursive: true })
    return { canceled: false, filePath: `${folder}/${name}` }
  },

  showErrorBox(title: string, content: string): void {
    void askPage({ op: 'messageBox', message: title, detail: content, buttons: ['OK'], cancelId: 0 })
  }
}

export const MAIN_WINDOW_ID = 1

const edit = (role: EditRole) => (): void => void askPage({ op: 'edit', role })

let zoomLevel = 0

const mainContents = {
  id: MAIN_WINDOW_ID,
  undo: edit('undo'),
  redo: edit('redo'),
  cut: edit('cut'),
  copy: edit('copy'),
  paste: edit('paste'),
  selectAll: edit('selectAll'),
  toggleDevTools(): void {},
  getZoomLevel: (): number => zoomLevel,
  setZoomLevel(level: number): void {
    zoomLevel = level
    void askPage({ op: 'zoom', level })
  },
  // The system keyboard owns spelling on iOS, vocabulary and language both.
  session: {
    addWordToSpellCheckerDictionary(_word: string): void {},
    setSpellCheckerLanguages(_languages: string[]): void {}
  }
}

export type MainContents = typeof mainContents

const mainWindow = {
  id: MAIN_WINDOW_ID,
  webContents: mainContents,
  setTitle(title: string): void {
    void askPage({ op: 'setTitle', title })
  },
  isFullScreen: (): boolean => true,
  setFullScreen(_value: boolean): void {},
  close(): void {},
  isDestroyed: (): boolean => false
}

export type MainWindow = typeof mainWindow

/**
 * `new BrowserWindow()` is how the print service gets a page to lay a
 * manuscript out in, and that is the only thing constructed here: the instance
 * holds the HTML it is given and hands it to the system print sheet.
 */
export class BrowserWindow {
  static fromId(id: number): MainWindow | null {
    return id === MAIN_WINDOW_ID ? mainWindow : null
  }
  static fromWebContents(contents: { id: number }): MainWindow | null {
    return contents.id === MAIN_WINDOW_ID ? mainWindow : null
  }
  static getAllWindows(): MainWindow[] {
    return [mainWindow]
  }

  private html = ''

  readonly webContents = {
    executeJavaScript: async (): Promise<boolean> => true,
    print: (_options: unknown, done: (ok: boolean, error?: string) => void): void => {
      askPage({ op: 'print', html: this.html }).then(
        () => done(true),
        (error: Error) => done(false, error.message)
      )
    },
    printToPDF: async (): Promise<Buffer> => {
      throw new Error('Use Print, then save as PDF from the print sheet.')
    }
  }

  constructor(_options?: unknown) {}

  async loadURL(url: string): Promise<void> {
    const marker = ';base64,'
    const at = url.indexOf(marker)
    this.html = at === -1 ? '' : Buffer.from(url.slice(at + marker.length), 'base64').toString('utf8')
  }

  destroy(): void {}
}

export type InvokeEvent = { sender: MainContents; senderFrame: { url: string } }
type Handler = (event: InvokeEvent, payload: unknown) => unknown

const handlers = new Map<string, Handler>()

export const ipcMain = {
  handle(channel: string, handler: Handler): void {
    handlers.set(channel, handler)
  }
}

export const INTERNAL_URL = 'app://quoth/'

export async function dispatch(channel: string, payload: unknown): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`No handler registered for '${channel}'`)
  return handler({ sender: mainContents, senderFrame: { url: INTERNAL_URL } }, payload)
}

// Imported by desktop modules that are bundled for one helper and never run.
export { default as protocol, default as net, default as Menu, default as session } from './unavailable.js'
