import path from 'node:path'
import { ipcMain, dialog, shell, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { ipcContract, type IpcInvokeChannel, type IpcReq, type IpcRes } from '../../shared/ipc/contract.js'
import type { WindowManager } from '../windows/windowManager.js'
import type { AppStateService } from '../services/appState.js'
import { ProjectSession } from '../services/projectSession.js'
import { assetUrl } from '../protocol/assetProtocol.js'
import { AiKeyStore } from '../services/aiKeyStore.js'
import { ConnectionStore } from '../services/connectionStore.js'
import { KnownHostsStore } from '../services/knownHostsStore.js'
import type { OneDriveAuth } from '../services/oneDriveAuth.js'
import type { TemplateService } from '../services/templateService.js'
import { createAdapter } from '../vfs/vfsRegistry.js'
import { KnownHostsPolicy, hostKeyId, type HostKeyPolicy, type PresentedHostKey } from '../vfs/hostKeys.js'
import type { VfsAdapter } from '../vfs/types.js'
import { projectUri, defaultPort } from '../../shared/model/connection.js'
import { resolveSettings, providerInfo, type ChatMessage } from '../../shared/model/ai.js'
import { ulid } from 'ulid'
import { resolveInRoot } from '../vfs/paths.js'
import { validateRelativePath } from '../../shared/model/filename.js'
import { DOC_EXT, IGNORED_DIRS, MANIFEST_FILE } from '../../shared/constants.js'
import type { ExportItem } from '../../shared/model/manuscript.js'

/**
 * Refuse a name no Windows filesystem can hold.
 *
 * Checked here rather than in the adapter so every backend gets it: a project
 * served over SFTP from a Linux host is routinely opened on Windows, and a name
 * that works for the author who typed it and fails for their collaborator is
 * the worst of both. The message is written to be shown verbatim.
 */
function requirePortableName(target: string): void {
  const result = validateRelativePath(target)
  if (!result.ok) throw new Error(result.reason)
}

/**
 * `paths` normalises into `items` at the boundary, so `DocxService.export`
 * only ever sees one shape. `items` wins when both are present rather than
 * being merged with it — the two fields describe two different callers
 * (a plain document list versus the manuscript's document-and-heading
 * stream), not two halves of one request.
 */
function resolveExportItems(paths: string[], items: ExportItem[]): ExportItem[] {
  return items.length > 0 ? items : paths.map((path) => ({ kind: 'document' as const, path }))
}

/** What `docx:exportDialog` proposes when the caller has no name of its own. */
function defaultExportName(paths: string[]): string {
  const first = paths[0] ?? 'manuscript'
  return `${path.basename(first).replace(/\.pubdoc$/i, '')}${paths.length > 1 ? ' and others' : ''}`
}

/**
 * A document's stable id and title, read from the file itself.
 *
 * The binder identifies chapters by `docId`, and the index cannot supply one for
 * a file it has not reached — which is precisely the file an author has just
 * created and is about to add. Returns null rather than throwing so one
 * unreadable file cannot empty a picker.
 */
async function readIdentity(
  session: ProjectSession,
  target: string
): Promise<{ docId: string; title: string } | null> {
  try {
    const loaded = await session.documents.read(target)
    return { docId: loaded.doc.docId, title: loaded.doc.title }
  } catch {
    return null
  }
}

async function readIdentities(
  session: ProjectSession,
  paths: readonly string[]
): Promise<{ docId: string; path: string; title: string }[]> {
  const identities: { docId: string; path: string; title: string }[] = []
  for (const target of paths) {
    requirePortableName(target)
    const identity = await readIdentity(session, target)
    if (identity) identities.push({ ...identity, path: target })
  }
  return identities
}

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
  /** How the asset protocol finds the project a URL's token names. */
  byAssetToken(token: string): ProjectSession | undefined {
    return [...this.sessions.values()].find((session) => session.assetToken === token)
  }
}

export interface HandlerContext {
  windows: WindowManager
  sessions: SessionRegistry
  appState: AppStateService
  /**
   * Passed in rather than constructed here so that this and the VFS registry
   * share one access-token cache — two would mean two refreshes, and Microsoft
   * invalidates a rotated refresh token the moment the other one is spent.
   */
  oneDrive: OneDriveAuth
  /**
   * App-wide, not per project: templates outlive the project a "Save as
   * Template…" was run from, and the picker has to list them before any
   * project is open at all.
   */
  templates: TemplateService
}

/** A host key offered during a connection test, held until the author rules on it. */
interface PendingHostKey {
  hostId: string
  presented: PresentedHostKey
  verdict: 'unknown' | 'changed'
  previous: string
}

export function registerHandlers(context: HandlerContext): void {
  const { windows, sessions, appState, oneDrive, templates } = context
  // App-wide, not per project: a key belongs to the person, not the manuscript.
  const keys = new AiKeyStore()
  const connections = new ConnectionStore()
  // A second instance of the same file-backed store the VFS registry uses, as
  // with `ConnectionStore` above: both read on every call, so the file is the
  // single source of truth and there is no cache for the two to disagree about.
  const knownHosts = new KnownHostsStore()
  const hostKeys = new KnownHostsPolicy(knownHosts)
  /** By profile id, replaced on each test and cleared once accepted. */
  const pendingHostKeys = new Map<string, PendingHostKey>()

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
  handle('app:setTimelineOrientation', ({ orientation }) => appState.setTimelineOrientation(orientation))

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

  handle('templates:list', () => templates.list())

  handle('templates:instantiate', async ({ templateId, targetUri, name }, event) => {
    const ownerId = windows.ownerWindowId(event.sender)
    if (ownerId === null) throw new Error('Unknown window')

    let uri = targetUri
    if (!uri) {
      const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
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

  handle('doc:read', ({ path: target }, event) => requireSession(event).documents.read(target))

  handle('doc:resolve', ({ docId }, event) => {
    const resolved = requireSession(event).search.resolvePath(docId)
    return resolved ? { path: resolved } : null
  })

  handle('doc:create', async ({ path: target, title }, event) => {
    requirePortableName(target)
    const session = requireSession(event)
    const created = await session.documents.create(target, title)
    await session.search.indexDocument(created.path, created.mtime)
    return created
  })

  handle('doc:write', async ({ path: target, doc, expectedMtime }, event) => {
    const session = requireSession(event)
    const result = await session.documents.write(target, doc, expectedMtime)
    if (result.ok) {
      await session.search.indexDocument(target, result.mtime).catch(() => {})
      const reconciled = await session.notes.reconcile(doc.docId, doc.content).catch(() => null)
      if (reconciled) noteChanged(event, doc.docId)
    }
    return result
  })

  handle('doc:writeAsset', async ({ dataBase64, ext }, event) => {
    const session = requireSession(event)
    const assetPath = await session.documents.writeAsset(dataBase64, ext)
    return { path: assetPath, url: assetUrl(session, assetPath) }
  })

  /**
   * Import, having already been handed the files.
   *
   * Every imported document is indexed the way `doc:create` indexes a new one,
   * so a chapter brought in from Word is searchable and has its characters
   * suggested without waiting for the next full pass.
   */
  const importDocxFiles = async (
    session: ProjectSession,
    files: string[],
    targetDir: string
  ): Promise<IpcRes<'docx:import'>> => {
    const result = await session.docx.import(files, targetDir, session.manifest)
    if (result.stylesAdded > 0) {
      await session.saveManifest({ ...session.manifest, styles: result.styles })
    }
    for (const document of result.imported) {
      await session.search.indexDocument(document.path).catch(() => {})
    }
    return { imported: result.imported, warnings: result.warnings, stylesAdded: result.stylesAdded }
  }

  handle('docx:import', ({ files, targetDir }, event) =>
    importDocxFiles(requireSession(event), files, targetDir)
  )

  handle('docx:importDialog', async ({ targetDir }, event) => {
    const session = requireSession(event)
    const window = BrowserWindow.fromWebContents(event.sender)
    const picked = await dialog.showOpenDialog(window!, {
      title: 'Import Word documents',
      filters: [{ name: 'Word documents', extensions: ['docx'] }],
      properties: ['openFile', 'multiSelections']
    })
    if (picked.canceled || picked.filePaths.length === 0) return null
    return importDocxFiles(session, picked.filePaths, targetDir)
  })

  handle('docx:export', async ({ paths, items, file }, event) => {
    const session = requireSession(event)
    await session.docx.export(resolveExportItems(paths, items), file, session.manifest)
    return { ok: true as const, file }
  })

  handle('docx:exportDialog', async ({ paths, items, suggestedName }, event) => {
    const session = requireSession(event)
    const window = BrowserWindow.fromWebContents(event.sender)
    const suggested = `${suggestedName ?? defaultExportName(paths)}.docx`
    const picked = await dialog.showSaveDialog(window!, {
      title: 'Export to Word',
      defaultPath: suggested,
      filters: [{ name: 'Word documents', extensions: ['docx'] }]
    })
    if (picked.canceled || !picked.filePath) return null
    await session.docx.export(resolveExportItems(paths, items), picked.filePath, session.manifest)
    return { ok: true as const, file: picked.filePath }
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

  function noteChanged(event: IpcMainInvokeEvent, docId: string): void {
    const ownerId = windows.ownerWindowId(event.sender)
    if (ownerId !== null) windows.sendToSession(ownerId, 'notes:changed', { docId })
  }

  handle('notes:list', ({ docId }, event) => requireSession(event).notes.listForDoc(docId))
  handle('notes:create', async ({ docId, anchorId, anchorText, blockIndex }, event) => {
    const note = await requireSession(event).notes.create(docId, anchorId, anchorText, blockIndex)
    noteChanged(event, docId)
    return note
  })
  handle('notes:save', async ({ docId, note }, event) => {
    const saved = await requireSession(event).notes.save(docId, note)
    noteChanged(event, docId)
    return saved
  })
  handle('notes:delete', async ({ docId, noteId }, event) => {
    await requireSession(event).notes.remove(docId, noteId)
    noteChanged(event, docId)
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

  handle('manuscript:view', (_payload, event) => requireSession(event).manuscript.view())
  handle('manuscript:createPart', async ({ title, role }, event) => {
    const session = requireSession(event)
    await session.manuscript.createPart(title, role)
    return session.manuscript.view()
  })
  handle('manuscript:addDocuments', async ({ paths, parentId }, event) => {
    const session = requireSession(event)
    await session.manuscript.addDocuments(await readIdentities(session, paths), parentId)
    return session.manuscript.view()
  })
  handle('manuscript:move', async ({ id, parentId, index }, event) => {
    const session = requireSession(event)
    await session.manuscript.move(id, parentId, index)
    return session.manuscript.view()
  })
  handle('manuscript:rename', async ({ id, title }, event) => {
    const session = requireSession(event)
    await session.manuscript.rename(id, title)
    return session.manuscript.view()
  })
  handle('manuscript:setRole', async ({ id, role }, event) => {
    const session = requireSession(event)
    await session.manuscript.setRole(id, role)
    return session.manuscript.view()
  })
  handle('manuscript:relink', async ({ id, path: target }, event) => {
    const session = requireSession(event)
    const [identity] = await readIdentities(session, [target])
    if (!identity) throw new Error(`${target} is not a readable document`)
    await session.manuscript.relink(id, identity.docId, identity.path, identity.title)
    return session.manuscript.view()
  })
  handle('manuscript:remove', async ({ id }, event) => {
    const session = requireSession(event)
    await session.manuscript.remove(id)
    return session.manuscript.view()
  })
  handle('manuscript:candidates', async (_payload, event) => {
    const session = requireSession(event)
    const inBook = new Set(
      session.manuscript.snapshot().nodes.map((node) => node.docId).filter(Boolean)
    )
    const known = session.search.knownDocuments()
    const files = (await session.adapter.walk('', IGNORED_DIRS)).filter((entry) =>
      entry.path.endsWith(DOC_EXT)
    )
    const candidates: { path: string; title: string; docId: string; inBook: boolean }[] = []
    for (const file of files) {
      // The index covers this in one query for everything already scanned; only
      // a file it has not reached yet costs a read, so opening the picker on a
      // warm project touches no files at all.
      const identity = known.get(file.path) ?? (await readIdentity(session, file.path))
      if (!identity) continue
      candidates.push({ ...identity, path: file.path, inBook: inBook.has(identity.docId) })
    }
    return candidates.sort((a, b) => a.path.localeCompare(b.path))
  })

  handle('maps:list', (_payload, event) => requireSession(event).maps.snapshot())
  handle('maps:create', ({ name, background, width, height }, event) => {
    // The renderer only ever passes back what doc:writeAsset returned, but a
    // path is a path: check it here like every other renderer-supplied one.
    if (background) requirePortableName(background)
    return requireSession(event).maps.create({ name, background, width, height })
  })
  handle('maps:save', ({ map }, event) => {
    if (map.background) requirePortableName(map.background)
    return requireSession(event).maps.save(map)
  })
  handle('maps:delete', async ({ id }, event) => {
    await requireSession(event).maps.remove(id)
    return { ok: true as const }
  })

  handle('sources:list', (_payload, event) => requireSession(event).sources.snapshot())
  handle('sources:create', ({ type }, event) => requireSession(event).sources.create(type))
  handle('sources:save', ({ source }, event) => requireSession(event).sources.save(source))
  handle('sources:delete', async ({ id }, event) => {
    await requireSession(event).sources.remove(id)
    return { ok: true as const }
  })

  handle('ai:list', (_payload, event) => requireSession(event).chats.snapshot())
  handle('ai:createChat', ({ title }, event) => requireSession(event).chats.create(title))
  handle('ai:saveChat', ({ chat }, event) => requireSession(event).chats.save(chat))
  handle('ai:deleteChat', async ({ id }, event) => {
    await requireSession(event).chats.remove(id)
    return { ok: true as const }
  })
  handle('ai:saveSettings', ({ settings }, event) =>
    requireSession(event).chats.saveSettings(settings)
  )

  handle('ai:keyStatus', () => ({
    configured: keys.configured(),
    secureStorage: keys.available()
  }))
  handle('ai:setKey', ({ provider, key }) => keys.set(provider, key))
  handle('ai:listModels', ({ settings }, event) => {
    const resolved = resolveSettings(settings)
    return requireSession(event).ai.listModels(resolved, keys.get(resolved.provider))
  })

  /**
   * Send a message and stream the reply.
   *
   * The user's message is stored before the request goes out, so a failed or
   * cancelled reply still leaves what they wrote in the conversation.
   */
  handle('ai:send', async ({ chatId, text, context: attached }, event) => {
    const session = requireSession(event)
    const chat = session.chats.get(chatId)
    if (!chat) throw new Error('That chat no longer exists')

    const settings = resolveSettings(session.chats.settings(), chat.settings)
    const info = providerInfo(settings.provider)
    const apiKey = keys.get(settings.provider)
    if (info.needsKey && !apiKey) {
      throw new Error(`No API key is set for ${info.name}. Add one in the AI panel's settings.`)
    }

    const body = attached.trim() ? `${text}\n\n---\n${attached.trim()}` : text
    const message: ChatMessage = {
      id: ulid(),
      role: 'user',
      text: body,
      model: '',
      created: new Date().toISOString()
    }
    const updated = await session.chats.append(chatId, message)
    if (!updated) throw new Error('That chat no longer exists')

    const requestId = ulid()
    const ownerId = windows.ownerWindowId(event.sender)
    void session.ai
      .run({
        requestId,
        settings,
        system: settings.systemPrompt,
        messages: updated.messages.map((item) => ({ role: item.role, text: item.text })),
        apiKey,
        onEvent: (streamEvent) => {
          if (ownerId !== null) windows.sendToSession(ownerId, 'ai:stream', streamEvent)
          // Persist only the finished reply: writing every delta would rewrite
          // the whole chat file on each token.
          if (streamEvent.type === 'done') {
            void session.chats.append(chatId, streamEvent.message).catch(() => {})
          }
        }
      })
      .catch(() => {})

    return { requestId, message }
  })

  handle('ai:cancel', ({ requestId }, event) => {
    requireSession(event).ai.cancel(requestId)
    return { ok: true as const }
  })

  handle('connections:list', () => ({
    connections: connections.list(),
    secureStorage: connections.secureStorageAvailable()
  }))

  handle('connections:save', ({ profile, secret }) =>
    connections.save(
      { ...profile, port: profile.port || defaultPort(profile.protocol) },
      secret
    )
  )

  handle('connections:delete', ({ id }) => {
    connections.remove(id)
    // The accepted host key stays: it belongs to the host, not to this profile,
    // and another profile — or this one, saved again — reaches the same server.
    pendingHostKeys.delete(id)
    return { ok: true as const }
  })

  /**
   * Open the connection and read its root.
   *
   * Worth its own channel: a typo in a host or a path otherwise surfaces as a
   * project that opens empty, which reads like data loss rather than a mistake.
   */
  handle('connections:test', async ({ id }) => {
    const profile = connections.get(id)
    if (!profile) {
      return { ok: false, message: 'That server is no longer saved.', entries: 0, hostKey: null }
    }

    /*
     * Watch what the host-key policy turns away.
     *
     * The wrapper only observes — the verdict is still the real policy's, so
     * testing a connection can never accept a key that opening a project would
     * refuse. Recording it here is what lets the dialog show the fingerprint
     * instead of a bare failure, and it is the only place the key is kept:
     * accepting one has to happen while this record is still in hand.
     */
    const refused: PendingHostKey[] = []
    const watching: HostKeyPolicy = {
      check: (host, port, key) => {
        const decision = hostKeys.check(host, port, key)
        if (!decision.ok) {
          refused.push({
            hostId: hostKeyId(host, port),
            presented: decision.presented,
            verdict: decision.verdict,
            previous: decision.previous
          })
        }
        return decision
      }
    }

    // Building the adapter is inside the try because it is one of the ways this
    // fails: an unreadable private key, or a OneDrive profile with no client
    // id, throws here rather than on connect. Left outside, those escaped the
    // handler entirely and the dialog fell back to "Could not reach the
    // server." — which sends the author looking for a network fault when the
    // actual problem is a path they can see and fix.
    let adapter: VfsAdapter | null = null
    try {
      adapter = createAdapter(projectUri(profile), { hostKeys: watching })
      const entries = await adapter.list('')
      const where = profile.protocol === 'onedrive' ? profile.account || 'OneDrive' : profile.host
      return { ok: true, message: `Connected to ${where}.`, entries: entries.length, hostKey: null }
    } catch (error) {
      const pending = refused.at(-1) ?? null
      if (pending) pendingHostKeys.set(id, pending)
      else pendingHostKeys.delete(id)
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        entries: 0,
        hostKey: pending
          ? { ...pending.presented, verdict: pending.verdict, previous: pending.previous }
          : null
      }
    } finally {
      await adapter?.dispose().catch(() => {})
    }
  })

  /**
   * Accept a host key the author has just read the fingerprint of.
   *
   * Only the key main saw during that profile's most recent test can be
   * accepted, and only when the renderer echoes back the fingerprint it
   * displayed. That is what keeps this from being a channel that writes
   * arbitrary trust: a dialog left open while the server changed underneath it
   * commits nothing, because the fingerprint no longer matches.
   */
  handle('connections:trustHostKey', ({ id, fingerprint }) => {
    const pending = pendingHostKeys.get(id)
    if (!pending) {
      return { ok: false, message: 'Test the connection again before accepting its fingerprint.' }
    }
    if (pending.presented.fingerprint !== fingerprint) {
      return { ok: false, message: 'That fingerprint is out of date. Test the connection again.' }
    }
    knownHosts.trust(pending.hostId, pending.presented)
    pendingHostKeys.delete(id)
    return { ok: true, message: 'This server’s identity has been accepted.' }
  })

  /**
   * Sign in to OneDrive.
   *
   * The failure is returned rather than thrown: every way this goes wrong is
   * something the author can fix — the wrong client id, a redirect URI the
   * registration does not list, a consent dialog they closed — and the dialog
   * shows the message beside the fields that caused it.
   */
  handle('connections:signIn', async ({ id }) => {
    try {
      const { account } = await oneDrive.signIn(id)
      return { ok: true, account, message: account ? `Signed in as ${account}.` : 'Signed in.' }
    } catch (error) {
      return { ok: false, account: '', message: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('connections:signOut', ({ id }) => {
    oneDrive.signOut(id)
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
  handle('snapshot:restore', async (request, event) => {
    const session = requireSession(event)
    if (request.mode === 'inPlace') {
      const result = await session.history.restoreInPlace(request.docId, request.timestamp)
      if (result.ok) return { ok: true as const, docId: request.docId, path: result.path, mtime: result.mtime }
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
}

/** Human-readable project name for a folder path, used before a manifest exists. */
export function projectNameFor(uri: string): string {
  return path.basename(uri)
}
