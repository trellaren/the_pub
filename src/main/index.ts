import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, session } from 'electron'
import { WindowManager } from './windows/windowManager.js'
import { startRendererServer, type RendererServer } from './server/rendererServer.js'
import fs from 'node:fs'
import { registerHandlers, SessionRegistry } from './ipc/registerHandlers.js'
import { ConnectionStore } from './services/connectionStore.js'
import { OneDriveAuth } from './services/oneDriveAuth.js'
import { setConnectionResolver } from './vfs/vfsRegistry.js'
import { AppStateService } from './services/appState.js'
import { registerAssetProtocol, registerAssetSchemePrivileges } from './protocol/assetProtocol.js'
import { buildMenu } from './menu.js'

// Must run before `app.whenReady()`.
registerAssetSchemePrivileges()

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

const windows = new WindowManager()
const sessions = new SessionRegistry()
let rendererServer: RendererServer | null = null

app.whenReady().then(async () => {
  const appState = new AppStateService()

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    windows.setRendererBaseUrl(devUrl)
  } else {
    // Packaged builds serve the renderer over loopback rather than file://, so
    // the app has a real origin and torn-off panes can share its JS context.
    const rendererDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../renderer')
    rendererServer = await startRendererServer(rendererDir)
    windows.setRendererBaseUrl(rendererServer.baseUrl)
  }

  registerAssetProtocol(() => sessions.roots())
  applyContentSecurityPolicy()

  // The registry builds remote adapters, so it needs a way to reach saved
  // servers — injected here rather than imported, so the vfs layer stays free
  // of Electron and testable on its own.
  const connections = new ConnectionStore()
  const oneDrive = new OneDriveAuth(connections)
  setConnectionResolver({
    profile: (id) => connections.get(id),
    secret: (id) => connections.secret(id),
    privateKey: (profile) => {
      try {
        return fs.readFileSync(profile.privateKeyPath, 'utf8')
      } catch {
        return null
      }
    },
    oneDriveTokens: (id) => oneDrive.tokenSource(id)
  })

  registerHandlers({ windows, sessions, appState, oneDrive })
  appState.onChange((state) => windows.broadcast('app:stateChanged', state))

  const createWindow = (): BrowserWindow => windows.createProjectWindow()
  windows.setProjectWindowHandler((window) => {
    window.on('closed', () => void sessions.close(window.id))
  })
  buildMenu(windows, createWindow)

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('second-instance', () => {
  const [existing] = BrowserWindow.getAllWindows()
  if (existing) {
    if (existing.isMinimized()) existing.restore()
    existing.focus()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void Promise.all(sessions.all().map((projectSession) => projectSession.close()))
  void rendererServer?.close()
})

/**
 * Lock the renderer down to its own bundle. The app never loads remote content,
 * so anything pasted into a document that tries to reach the network is inert.
 * `'unsafe-inline'` for styles is required by the editor, which sets inline
 * styles for formatting, and by dockview's layout sizing.
 */
function applyContentSecurityPolicy(): void {
  const isDev = Boolean(process.env['ELECTRON_RENDERER_URL'])
  const policy = [
    "default-src 'self'",
    `script-src 'self'${isDev ? " 'unsafe-inline' 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: pub-asset:",
    "font-src 'self' data:",
    isDev ? 'connect-src *' : "connect-src 'self'",
    "object-src 'none'",
    "frame-src 'none'"
  ].join('; ')

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [policy] }
    })
  })
}
