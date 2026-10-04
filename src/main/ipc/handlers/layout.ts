import { app, BrowserWindow } from 'electron'
import type { MenuItemRole } from '../../../shared/menu/menuRoles.js'
import { requirePortableName, type HandlerContext } from '../context.js'

/**
 * The action behind a built-in menu role, for the menu the app draws itself.
 *
 * Electron only performs these when *it* drew the item, so an in-window menu
 * has to ask for them by name. The editing roles go to the web contents the
 * click came from rather than to the focused window, for the same reason the
 * window buttons do — and because a popout is a web contents of its own with
 * its own selection to cut.
 */
function runMenuRole(role: MenuItemRole, contents: Electron.WebContents): void {
  const window = BrowserWindow.fromWebContents(contents)
  switch (role) {
    case 'undo': return contents.undo()
    case 'redo': return contents.redo()
    case 'cut': return contents.cut()
    case 'copy': return contents.copy()
    case 'paste': return contents.paste()
    case 'selectAll': return contents.selectAll()
    case 'reload': return contents.reload()
    case 'toggleDevTools': return contents.toggleDevTools()
    // Zoom is per web contents, and the steps match Electron's own roles.
    case 'resetZoom': return contents.setZoomLevel(0)
    case 'zoomIn': return contents.setZoomLevel(contents.getZoomLevel() + 0.5)
    case 'zoomOut': return contents.setZoomLevel(contents.getZoomLevel() - 0.5)
    case 'togglefullscreen':
      window?.setFullScreen(!window.isFullScreen())
      return
    case 'close':
      window?.close()
      return
    case 'quit':
      app.quit()
      return
  }
}

export function register(ctx: HandlerContext): void {
  const { handle, windows, requireSession, openInto, noteChanged } = ctx

  handle('layout:load', (_payload, event) => requireSession(event).layout.load())
  handle('layout:saveLast', async ({ layout }, event) => {
    await requireSession(event).layout.saveLast(layout)
    return { ok: true as const }
  })
  handle('layout:savePreset', ({ name, layout }, event) =>
    requireSession(event).layout.savePreset(name, layout)
  )
  handle('layout:deletePreset', async ({ id }, event) => {
    await requireSession(event).layout.deletePreset(id)
    return { ok: true as const }
  })

  handle('snapshot:list', ({ docId }, event) => requireSession(event).snapshots.list(docId))
  handle('snapshot:restore', async (request, event) => {
    const session = requireSession(event)
    if (request.mode === 'inPlace') {
      const result = await session.history.restoreInPlace(request.docId, request.timestamp)
      if (result.ok) {
        if (result.notesChanged) noteChanged(event, request.docId)
        return { ok: true as const, docId: request.docId, path: result.path, mtime: result.mtime }
      }
      if (result.reason === 'conflict') {
        return { ok: false as const, reason: 'conflict' as const, diskMtime: result.diskMtime }
      }
      if (result.reason === 'format-too-new') {
        return { ok: false as const, reason: 'format-too-new' as const, diskVersion: result.diskVersion }
      }
      return { ok: false as const, reason: 'missing-document' as const }
    }
    requirePortableName(request.targetPath)
    const loaded = await session.history.restoreToNewFile(
      request.docId,
      request.timestamp,
      request.targetPath
    )
    return { ok: true as const, docId: loaded.doc.docId, path: loaded.path, mtime: loaded.mtime }
  })
  handle('snapshot:read', ({ docId, timestamp }, event) =>
    requireSession(event).snapshots.read(docId, timestamp)
  )

  handle('window:newProject', async ({ uri }) => {
    const window = windows.createProjectWindow()
    if (uri) {
      // Wait for the renderer before opening, so it receives the project state.
      window.webContents.once('did-finish-load', () => {
        void openInto(window.id, uri).catch(() => {})
      })
    }
    return { ok: true as const }
  })

  handle('window:closeConfirmed', (_payload, event) => {
    windows.confirmClose(event.sender)
    return { ok: true as const }
  })

  handle('window:minimize', (_payload, event) => {
    windows.minimize(event.sender)
    return { ok: true as const }
  })

  handle('window:toggleMaximize', (_payload, event) => windows.toggleMaximize(event.sender))

  handle('window:close', (_payload, event) => {
    windows.requestClose(event.sender)
    return { ok: true as const }
  })

  handle('window:chromeState', (_payload, event) => windows.chromeState(event.sender))

  handle('window:menuRole', ({ role }, event) => {
    runMenuRole(role, event.sender)
    return { ok: true as const }
  })
}
