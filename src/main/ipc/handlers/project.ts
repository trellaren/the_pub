import { dialog, shell } from 'electron'
import { createAdapter } from '../../vfs/vfsRegistry.js'
import { normalizeRelative, resolveInRoot } from '../../vfs/paths.js'
import { FONTS_DIR, MANIFEST_FILE } from '../../../shared/constants.js'
import { FONT_EXTENSIONS } from '../../../shared/model/asset.js'
import { requirePortableName, type HandlerContext } from '../context.js'
import { importFontFile } from './fontImport.js'

export function register(ctx: HandlerContext): void {
  const { handle, windows, sessions, appState, templates, requireSession, ownerWindow, pickFiles, openInto } = ctx

  handle('project:openDialog', async (_payload, event) => {
    const result = await dialog.showOpenDialog(ownerWindow(event), {
      title: 'Open project folder',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const ownerId = windows.ownerWindowId(event.sender)
    if (ownerId === null) throw new Error('Unknown window')
    const session = await openInto(ownerId, result.filePaths[0]!)
    return session.toOpenProject()
  })

  handle('project:open', async ({ uri }, event) => {
    const ownerId = windows.ownerWindowId(event.sender)
    if (ownerId === null) throw new Error('Unknown window')
    const session = await openInto(ownerId, uri)
    return session.toOpenProject()
  })

  handle('project:close', async (_payload, event) => {
    const ownerId = windows.ownerWindowId(event.sender)
    if (ownerId !== null) {
      await sessions.close(ownerId)
      for (const window of windows.windowsForSession(ownerId)) window.setTitle('Quoth')
    }
    return { ok: true as const }
  })

  handle('project:forgetRecent', ({ uri }) => appState.removeRecent(uri))

  handle('project:updateManifest', async ({ manifest }, event) =>
    requireSession(event).saveManifest(manifest)
  )

  handle('templates:list', () => templates.list())

  handle('templates:instantiate', async ({ templateId, targetUri, name }, event) => {
    const ownerId = windows.ownerWindowId(event.sender)
    if (ownerId === null) throw new Error('Unknown window')

    let uri = targetUri
    if (!uri) {
      const result = await dialog.showOpenDialog(ownerWindow(event), {
        title: `New ${name}`,
        message: 'Choose an empty folder for the new project',
        buttonLabel: 'Create Project',
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) return null
      uri = result.filePaths[0]!
    }

    // A folder that already holds a project would have its manifest replaced
    // and its styles overwritten by the template's. Refuse rather than ask: the
    // author reached for "new project", and there is no reading of that which
    // means "overwrite the one already here".
    const target = createAdapter(uri)
    try {
      if (await target.stat(MANIFEST_FILE)) {
        throw new Error('That folder already holds a project. Choose an empty folder.')
      }
      await templates.instantiate(templateId, target, name)
    } finally {
      await target.dispose()
    }
    const session = await openInto(ownerId, uri)
    return session.toOpenProject()
  })

  handle('templates:saveAs', async ({ options }, event) => {
    const session = requireSession(event)
    return templates.saveAsTemplate(session.adapter, session.manifest, options)
  })

  handle('templates:delete', async ({ templateId }) => {
    await templates.remove(templateId)
    return { ok: true as const }
  })

  handle('templates:applyPreset', ({ templateId }) => templates.presetStylesAndPage(templateId))

  handle('fonts:importDialog', async (_payload, event) => {
    const session = requireSession(event)
    const files = await pickFiles(event, {
      title: 'Import a font',
      filters: [{ name: 'Fonts', extensions: [...FONT_EXTENSIONS] }],
      multiple: false
    })
    return files && importFontFile(session, files[0]!)
  })
  handle('fonts:delete', async ({ file }, event) => {
    const session = requireSession(event)
    const relative = normalizeRelative(file)
    // Only what fonts:importDialog wrote. This channel must not become a generic
    // delete-anything-in-the-project with a friendlier name.
    if (!relative.startsWith(`${FONTS_DIR}/`)) throw new Error('That is not an imported font.')
    try {
      await session.adapter.delete(relative)
    } catch (error) {
      // Already gone is the outcome asked for; anything else is a real failure.
      const stillThere = await session.adapter.stat(relative).then(() => true, () => false)
      if (stillThere) throw error
    }
    return { ok: true as const }
  })

  handle('vfs:list', ({ path: target }, event) => requireSession(event).adapter.list(target))
  handle('vfs:stat', ({ path: target }, event) => requireSession(event).adapter.stat(target))

  handle('vfs:mkdir', async ({ path: target }, event) => {
    requirePortableName(target)
    await requireSession(event).adapter.mkdir(target)
    return { ok: true as const }
  })

  handle('vfs:rename', async ({ from, to }, event) => {
    requirePortableName(to)
    await requireSession(event).adapter.rename(from, to)
    return { ok: true as const }
  })

  /*
   * Deleting, via the trash where there is one.
   *
   * `session.root` is a directory only for a local project; for one on a server
   * it is a URI, and resolving a project-relative path against it produced a
   * path under the working directory that named nothing. The trash call then
   * failed, the adapter delete in the `catch` ran, and the file did go — so
   * this worked, by accident, on the strength of an error. It stops being an
   * accident here: the operating system is asked only where the question makes
   * sense, and the adapter is asked everywhere else.
   */
  handle('vfs:delete', async ({ path: target, recursive }, event) => {
    const session = requireSession(event)
    if (session.isLocal) {
      // Deleting a manuscript is destructive and easy to misclick, so route it
      // to the OS trash where the author can get it back.
      try {
        await shell.trashItem(resolveInRoot(session.root, target))
        return { ok: true as const }
      } catch {
        // No trash on this system, or the file is somewhere it cannot reach.
      }
    }
    await session.adapter.delete(target, { recursive })
    return { ok: true as const }
  })

  handle('vfs:revealInOs', ({ path: target }, event) => {
    const session = requireSession(event)
    // Nothing to open: the file is on a server, and the file manager would be
    // handed a path assembled out of a URI. The tree hides this for remote
    // projects, and this is what makes that more than a convention.
    if (!session.isLocal) {
      throw new Error('This project is on a server, so there is no folder to show on this machine.')
    }
    shell.showItemInFolder(resolveInRoot(session.root, target))
    return { ok: true as const }
  })
}
