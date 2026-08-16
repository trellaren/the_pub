import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, session } from 'electron'
import { WindowManager } from './windows/windowManager.js'
import { startRendererServer, type RendererServer } from './server/rendererServer.js'
import fs from 'node:fs'
import { registerHandlers, SessionRegistry } from './ipc/registerHandlers.js'
import { ConnectionStore } from './services/connectionStore.js'
import { KnownHostsStore } from './services/knownHostsStore.js'
import { OneDriveAuth } from './services/oneDriveAuth.js'
import { setConnectionResolver } from './vfs/vfsRegistry.js'
import { KnownHostsPolicy } from './vfs/hostKeys.js'
import { AppStateService } from './services/appState.js'
import { TemplateService } from './services/templateService.js'
import { registerAssetProtocol, registerAssetSchemePrivileges } from './protocol/assetProtocol.js'
import { buildMenu } from './menu.js'

// Must run before `app.whenReady()`.
registerAssetSchemePrivileges()

/*
 * A second copy of the app hands its arguments to the first and stops here.
 *
 * `app.quit()` alone is not enough: it is asynchronous, so this module would
 * keep evaluating and `whenReady` could still fire — binding a second loopback
 * server and opening a second window before the quit lands. `app.exit` is
 * immediate, and this process has nothing to flush because it has not opened
 * anything yet. Far more likely with a packaged app, which gets double-clicked,
 * than with `npm run dev`.
 */
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
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

  registerAssetProtocol({
    byToken: (token) => sessions.byAssetToken(token) ?? null,
    roots: () => sessions.roots()
  })
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
    oneDriveTokens: (id) => oneDrive.tokenSource(id),
    hostKeys: new KnownHostsPolicy(new KnownHostsStore())
  })

  registerHandlers({ windows, sessions, appState, oneDrive, templates: new TemplateService(templateDirs()) })
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

/*
 * Say so when startup fails.
 *
 * Everything above runs inside one `then`, and most of it — the loopback
 * server, the asset protocol, the IPC handlers, the first window — only runs in
 * a packaged build. An exception anywhere in there used to reject silently: no
 * window, no message, a dock icon that bounces once and stops. That is the
 * worst failure this app has, because there is nothing at all to go on.
 *
 * `showErrorBox` works before any window exists, which is exactly the case here.
 */
app.whenReady().then(
  () => undefined,
  (error: unknown) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    dialog.showErrorBox('The Pub could not start', detail)
    app.exit(1)
  }
)

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
 * Where the two kinds of project template live.
 *
 * The packaged path is not the dev path, and cannot be: `electron-vite dev`
 * never runs electron-builder, so `process.resourcesPath` holds Electron's own
 * resources rather than ours until a real build has copied `extraResources`
 * across. Getting this wrong shows up only in a packaged run, which is why the
 * packaged smoke test covers it.
 */
function templateDirs(): { builtin: string; user: string } {
  return {
    builtin: app.isPackaged
      ? path.join(process.resourcesPath, 'templates')
      : path.join(app.getAppPath(), 'resources', 'templates'),
    user: path.join(app.getPath('userData'), 'templates')
  }
}

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
    // `data:` is a same-bundle constant, never a remote host: `citeproc-plus`
    // ships part of its CSL style/locale catalog as `data:` URIs the browser
    // build resolves with `fetch()` rather than inlining, and blocking it
    // would not narrow what this policy actually defends against.
    isDev ? 'connect-src * data:' : "connect-src 'self' data:",
    "object-src 'none'",
    "frame-src 'none'"
  ].join('; ')

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [policy] }
    })
  })
}
