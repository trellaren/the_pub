import path from 'node:path'
import { ipcMain, dialog, shell, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { ipcContract, type IpcInvokeChannel, type IpcReq, type IpcRes } from '../../shared/ipc/contract.js'
import type { WindowManager } from '../windows/windowManager.js'
import type { AppStateService } from '../services/appState.js'
import { ProjectSession } from '../services/projectSession.js'
import { assetUrl } from '../protocol/assetProtocol.js'
import { AiKeyStore } from '../services/aiKeyStore.js'
import { ConnectionStore } from '../services/connectionStore.js'
import type { OneDriveAuth } from '../services/oneDriveAuth.js'
import { createAdapter } from '../vfs/vfsRegistry.js'
import type { VfsAdapter } from '../vfs/types.js'
import { projectUri, defaultPort } from '../../shared/model/connection.js'
import { resolveSettings, providerInfo, type ChatMessage } from '../../shared/model/ai.js'
import { ulid } from 'ulid'
import { resolveInRoot } from '../vfs/paths.js'
import { validateRelativePath } from '../../shared/model/filename.js'

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
}

export function registerHandlers(context: HandlerContext): void {
  const { windows, sessions, appState, oneDrive } = context
  // App-wide, not per project: a key belongs to the person, not the manuscript.
  const keys = new AiKeyStore()
  const connections = new ConnectionStore()

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
    requirePortableName(target)
    await requireSession(event).adapter.mkdir(target)
    return { ok: true as const }
  })

  handle('vfs:rename', async ({ from, to }, event) => {
    requirePortableName(to)
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
    requirePortableName(target)
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

  handle('docx:export', async ({ paths, file }, event) => {
    const session = requireSession(event)
    await session.docx.export(paths, file, session.manifest)
    return { ok: true as const, file }
  })

  handle('docx:exportDialog', async ({ paths }, event) => {
    const session = requireSession(event)
    const window = BrowserWindow.fromWebContents(event.sender)
    const first = paths[0] ?? 'manuscript'
    const suggested = `${path.basename(first).replace(/\.pubdoc$/i, '')}${paths.length > 1 ? ' and others' : ''}.docx`
    const picked = await dialog.showSaveDialog(window!, {
      title: 'Export to Word',
      defaultPath: suggested,
      filters: [{ name: 'Word documents', extensions: ['docx'] }]
    })
    if (picked.canceled || !picked.filePath) return null
    await session.docx.export(paths, picked.filePath, session.manifest)
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
    if (!profile) return { ok: false, message: 'That server is no longer saved.', entries: 0 }
    // Building the adapter is inside the try because it is one of the ways this
    // fails: an unreadable private key, or a OneDrive profile with no client
    // id, throws here rather than on connect. Left outside, those escaped the
    // handler entirely and the dialog fell back to "Could not reach the
    // server." — which sends the author looking for a network fault when the
    // actual problem is a path they can see and fix.
    let adapter: VfsAdapter | null = null
    try {
      adapter = createAdapter(projectUri(profile))
      const entries = await adapter.list('')
      const where = profile.protocol === 'onedrive' ? profile.account || 'OneDrive' : profile.host
      return { ok: true, message: `Connected to ${where}.`, entries: entries.length }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        entries: 0
      }
    } finally {
      await adapter?.dispose().catch(() => {})
    }
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
