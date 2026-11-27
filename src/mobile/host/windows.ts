import { BrowserWindow, INTERNAL_URL, MAIN_WINDOW_ID, type MainWindow } from './shims/electron.js'
import type { IpcEvent, IpcEventChannel } from '../../shared/ipc/contract.js'

const CHROME = { maximized: true, fullScreen: true }

/**
 * The window manager for an app that is one window.
 *
 * It answers the questions the handlers put to the desktop `WindowManager` —
 * whose window is this, where do events go — with the only answer there is,
 * and treats the buttons of a title bar that is never drawn as no-ops.
 */
export class MobileWindows {
  constructor(private readonly emit: (channel: string, payload: unknown) => void) {}

  isInternalUrl(url: string): boolean {
    return url === INTERNAL_URL
  }

  ownerWindowId(_contents: unknown): number | null {
    return MAIN_WINDOW_ID
  }

  send<K extends IpcEventChannel>(_contents: unknown, channel: K, payload: IpcEvent<K>): void {
    this.emit(channel, payload)
  }

  sendToSession<K extends IpcEventChannel>(_ownerId: number, channel: K, payload: IpcEvent<K>): void {
    this.emit(channel, payload)
  }

  broadcast<K extends IpcEventChannel>(channel: K, payload: IpcEvent<K>): void {
    this.emit(channel, payload)
  }

  windowsForSession(_ownerId: number): MainWindow[] {
    return BrowserWindow.getAllWindows()
  }

  createProjectWindow(): never {
    throw new Error('The iOS app has one window. Close this project to open another.')
  }

  confirmClose(): void {}
  minimize(): void {}
  requestClose(): void {}
  toggleMaximize(): typeof CHROME {
    return CHROME
  }
  chromeState(): typeof CHROME {
    return CHROME
  }
}
