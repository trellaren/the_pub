import path from 'node:path'
import { ipcMain, dialog, shell, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { ipcContract, type IpcInvokeChannel, type IpcReq, type IpcRes } from '../../shared/ipc/contract.js'
import type { WindowManager } from '../windows/windowManager.js'
import type { AppStateService } from '../services/appState.js'
import { ProjectSession } from '../services/projectSession.js'
import { assetUrl } from '../protocol/assetProtocol.js'
import { resolveInRoot } from '../vfs/paths.js'

/** One open project per top-level window; popouts resolve to their opener's. */
export class SessionRegistry {
  private sessions = new Map<number, ProjectSession>()

  get(ownerId: number): ProjectSession | undefined {
    return this.sessions.get(ownerId)
  }
  set(ownerId: number, session: ProjectSession): void {
    this.sessions.set(ownerId, session)
  }
  async close(ownerId: number): Promise<void> {
    const session = this.sessions.get(ownerId)
    if (!session) return
    this.sessions.delete(ownerId)
    await session.close()
  }
  roots(): string[] {
    return [...this.sessions.values()].map((session) => session.root)
  }
  all(): ProjectSession[] {
    return [...this.sessions.values()]
  }
}

export interface HandlerContext {
  windows: WindowManager
  sessions: SessionRegistry
  appState: AppStateService
}

export function registerHandlers(context: HandlerContext): void {
  const { windows, sessions, appState } = context

  /**
   * Bind a contract channel. The request is parsed with the channel's schema
   * before the implementation sees it, so handlers never guard their own inputs
   * and a malformed payload fails at the boundary with a useful message.
   */
  function handle<K extends IpcInvokeChannel>(
    channel: K,
    implementation: (payload: IpcReq<K>, event: IpcMainInvokeEvent) => Promise<IpcRes<K>> | IpcRes<K>
  ): void {
    ipcMain.handle(channel, async (event, raw) => {
      const parsed = ipcContract.invoke[channel].req.parse(raw ?? {}) as IpcReq<K>
      return implementation(parsed, event)
    })
  }

  /** Resolve the calling window's project, or fail loudly — there is no default. */
  function requireSession(event: IpcMainInvokeEvent): ProjectSession {
    const ownerId = windows.ownerWindowId(event.sender)
    const session = ownerId === null ? undefined : sessions.get(ownerId)
    if (!session) throw new Error('No project is open in this window')
    return session
  }

  async function openInto(ownerId: number, uri: string): Promise<ProjectSession> {
    await sessions.close(ownerId)
    const session = await ProjectSession.open(uri, {
      onFileChange: (events) => windows.sendToSession(ownerId, 'vfs:changed', events),
      onIndexProgress: (progress) => windows.sendToSession(ownerId, 'search:indexProgress', progress)
    })
    sessions.set(ownerId, session)
    appState.addRecent(uri, session.manifest.name)
    for (const window of windows.windowsForSession(ownerId)) {
      window.setTitle(`${session.manifest.name} — The Pub`)
    }
    return session
  }

  handle('app:getState', () => appState.get())
  handle('app:setTheme', ({ theme }) => appState.setTheme(theme))

  handle('project:openDialog', async (_payload, event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(window!, {
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
    if (ownerId !== null) await sessions.close(ownerId)
    return { ok: true as const }
  })

  handle('project:updateManifest', async ({ manifest }, event) =>
    requireSession(event).saveManifest(manifest)
  )

  handle('vfs:list', ({ path: target }, event) => requireSession(event).adapter.list(target))
  handle('vfs:stat', ({ path: target }, event) => requireSession(event).adapter.stat(target))

  handle('vfs:mkdir', async ({ path: target }, event) => {
    await requireSession(event).adapter.mkdir(target)
    return { ok: true as const }
  })

  handle('vfs:rename', async ({ from, to }, event) => {
    await requireSession(event).adapter.rename(from, to)
    return { ok: true as const }
  })

  handle('vfs:delete', async ({ path: target, recursive }, event) => {
    const session = requireSession(event)
    // Deleting a manuscript is destructive and easy to misclick, so route it to
    // the OS trash where the author can get it back.
    const absolute = resolveInRoot(session.root, target)
    try {
      await shell.trashItem(absolute)
    } catch {
      await session.adapter.delete(target, { recursive })
    }
    return { ok: true as const }
  })

  handle('vfs:revealInOs', ({ path: target }, event) => {
    const session = requireSession(event)
    shell.showItemInFolder(resolveInRoot(session.root, target))
    return { ok: true as const }
  })

  handle('doc:read', ({ path: target }, event) => requireSession(event).documents.read(target))

  handle('doc:resolve', ({ docId }, event) => {
    const resolved = requireSession(event).search.resolvePath(docId)
    return resolved ? { path: resolved } : null
  })

  handle('doc:create', async ({ path: target, title }, event) => {
    const session = requireSession(event)
    const created = await session.documents.create(target, title)
    await session.search.indexDocument(created.path, created.mtime)
    return created
  })

  handle('doc:write', async ({ path: target, doc, expectedMtime }, event) => {
    const session = requireSession(event)
    const result = await session.documents.write(target, doc, expectedMtime)
    if (result.ok) await session.search.indexDocument(target, result.mtime).catch(() => {})
    return result
  })

  handle('doc:writeAsset', async ({ dataBase64, ext }, event) => {
    const session = requireSession(event)
    const assetPath = await session.documents.writeAsset(dataBase64, ext)
    return { path: assetPath, url: assetUrl(session.root, assetPath) }
  })

  handle('search:query', (query, event) => requireSession(event).search.query(query))
  handle('search:status', (_payload, event) => requireSession(event).search.getProgress())
  handle('search:reindex', async (_payload, event) => {
    void requireSession(event).search.syncAll(true).catch(() => {})
    return { ok: true as const }
  })

  /**
   * Re-scan suggestions after a change to the records, and tell the window's
   * backlink lists to refetch. Confirmed mentions are untouched by this, so a
   * rename costs no file reads at all.
   */
  function rescan(event: IpcMainInvokeEvent): void {
    const session = requireSession(event)
    session.search.invalidateRoster()
    session.search.rescanSuggestions()
    const ownerId = windows.ownerWindowId(event.sender)
    if (ownerId !== null) windows.sendToSession(ownerId, 'mentions:changed', {})
  }

  handle('entities:list', (_payload, event) => requireSession(event).entities.snapshot())
  handle('entities:create', async ({ kind, name }, event) => {
    const entity = await requireSession(event).entities.create(kind, name)
    rescan(event)
    return entity
  })
  handle('entities:save', async ({ entity }, event) => {
    const saved = await requireSession(event).entities.save(entity)
    rescan(event)
    return saved
  })
  handle('entities:delete', async ({ id }, event) => {
    const session = requireSession(event)
    await session.entities.remove(id)
    rescan(event)
    return { ok: true as const }
  })

  handle('mentions:forEntity', (request, event) =>
    requireSession(event).search.mentionsForEntity(request)
  )
  handle('mentions:summary', (_payload, event) => requireSession(event).search.mentionSummary())
  handle('mentions:confirm', async (ref, event) => {
    const result = await requireSession(event).mentions.confirm(ref)
    const ownerId = windows.ownerWindowId(event.sender)
    if (result.ok && ownerId !== null) windows.sendToSession(ownerId, 'mentions:changed', {})
    return result
  })
  handle('mentions:confirmAll', async ({ entityId }, event) => {
    const result = await requireSession(event).mentions.confirmAll(entityId)
    const ownerId = windows.ownerWindowId(event.sender)
    if (ownerId !== null) windows.sendToSession(ownerId, 'mentions:changed', {})
    return result
  })
  handle('mentions:dismiss', async ({ entityId, docId, surface }, event) => {
    await requireSession(event).mentions.dismiss(entityId, docId, surface)
    const ownerId = windows.ownerWindowId(event.sender)
    if (ownerId !== null) windows.sendToSession(ownerId, 'mentions:changed', {})
    return { ok: true as const }
  })

  handle('beats:list', (_payload, event) => requireSession(event).beats.snapshot())
  handle('beats:create', ({ title, columnId, docId }, event) =>
    requireSession(event).beats.create({ title, columnId, docId })
  )
  handle('beats:save', ({ beat }, event) => requireSession(event).beats.save(beat))
  handle('beats:delete', async ({ id }, event) => {
    await requireSession(event).beats.remove(id)
    return { ok: true as const }
  })
  handle('beats:saveColumns', ({ columns }, event) =>
    requireSession(event).beats.saveColumns(columns)
  )

  handle('maps:list', (_payload, event) => requireSession(event).maps.snapshot())
  handle('maps:create', ({ name }, event) => requireSession(event).maps.create(name))
  handle('maps:save', ({ map }, event) => requireSession(event).maps.save(map))
  handle('maps:delete', async ({ id }, event) => {
    await requireSession(event).maps.remove(id)
    return { ok: true as const }
  })

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
}

/** Human-readable project name for a folder path, used before a manifest exists. */
export function projectNameFor(uri: string): string {
  return path.basename(uri)
}
