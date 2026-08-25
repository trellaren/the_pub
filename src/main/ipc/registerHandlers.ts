import path from 'node:path'
import fs from 'node:fs/promises'
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
import type { RendererServerLike } from '../print/printService.js'
import { createAdapter, inspectDatabase, createDatabaseProject } from '../vfs/vfsRegistry.js'
import { KnownHostsPolicy, hostKeyId, type HostKeyPolicy, type PresentedHostKey } from '../vfs/hostKeys.js'
import type { VfsAdapter } from '../vfs/types.js'
import { projectUri, defaultPort } from '../../shared/model/connection.js'
import os from 'node:os'
import { streamCompletion } from '../ai/aiRunner.js'
import {
  isFresh,
  pickAngle,
  promptRequest,
  today,
  EMPTY_DAILY_PROMPT
} from '../../shared/model/writingPrompt.js'

/** Long enough for a local model on a slow machine, short enough not to hang the card. */
const PROMPT_TIMEOUT_MS = 30_000

import {
  aiSettingsSchema,
  resolveSettings,
  providerInfo,
  type ChatMessage,
  type StreamEvent
} from '../../shared/model/ai.js'
import {
  resolveVariant,
  isSideloadedModel,
  DEFAULT_SIDELOAD_CONTEXT,
  type LlmProgress
} from '../../shared/model/llm.js'
import type { ModelStore } from '../llm/modelStore.js'
import type { LlmEngine } from '../llm/engine.js'
import { runAgent } from '../ai/agentRunner.js'
import { Embedder, embedderConfig, embedderRefusal } from '../ai/embedder.js'
import type { EmbedderResolution } from '../ai/embeddingIndexer.js'
import type { RetrievalResult } from '../ai/tools.js'
import { ulid } from 'ulid'
import { resolveInRoot } from '../vfs/paths.js'
import { validateRelativePath } from '../../shared/model/filename.js'
import { DOC_EXT, IGNORED_DIRS, MANIFEST_FILE } from '../../shared/constants.js'
import type { ExportItem } from '../../shared/model/manuscript.js'
import { exportWarnings, type PublishFormat } from '../../shared/model/publish.js'
import type { CslItem } from '../../shared/model/source.js'
import { parseBibtex } from '../sources/fromBibtex.js'
import { parseRis } from '../sources/fromRis.js'
import { lookupSource } from '../sources/lookup.js'
import { capturePage } from '../research/capture.js'

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
  /**
   * The embedded model, app-wide rather than per project: the weights are one
   * copy on disk serving every project, and only one model is loaded at a time
   * regardless of how many windows are open.
   */
  models: ModelStore
  engine: LlmEngine
  /** See `SessionHooks.rendererServer` — absent in dev and in tests. */
  rendererServer?: RendererServerLike
}

/** A host key offered during a connection test, held until the author rules on it. */
interface PendingHostKey {
  hostId: string
  presented: PresentedHostKey
  verdict: 'unknown' | 'changed'
  previous: string
}

export function registerHandlers(context: HandlerContext): void {
  const { windows, sessions, appState, oneDrive, templates, models, engine, rendererServer } = context
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
      onIndexProgress: (progress) => windows.sendToSession(ownerId, 'search:indexProgress', progress),
      resolveEmbedder: (allowStart) => resolveEmbedder(ownerId, allowStart),
      onRetrievalProgress: (status) => windows.sendToSession(ownerId, 'ai:retrievalProgress', status),
      author: () => appState.author(),
      rendererServer
    })
    sessions.set(ownerId, session)
    // Put ourselves in the project's registry on open, so a collaborator sees a
    // name against our comments rather than an id.
    await session.reviews.registerAuthor(appState.author()).catch(() => {})
    // The project's own words — character names above all — join the OS
    // spellchecker's vocabulary the moment the project is open, not only when
    // someone happens to right-click a flagged one.
    const words = await session.dictionary.load().catch(() => [])
    for (const word of words) {
      windows
        .windowsForSession(ownerId)[0]
        ?.webContents.session.addWordToSpellCheckerDictionary(word)
    }
    appState.addRecent(uri, session.manifest.name)
    for (const window of windows.windowsForSession(ownerId)) {
      window.setTitle(`${session.manifest.name} — The Pub`)
    }
    return session
  }

  handle('app:getState', () => appState.get())
  handle('app:setTheme', ({ theme }) => appState.setTheme(theme))
  handle('app:setTimelineOrientation', ({ orientation }) => appState.setTimelineOrientation(orientation))
  handle('app:setKeybinding', ({ commandId, accelerator }) =>
    appState.setKeybinding(commandId, accelerator)
  )
  handle('app:resetKeybindings', () => appState.resetKeybindings())
  handle('app:setAiEnabled', async ({ enabled }) => {
    // Turning it off stops the model now rather than at the next quit: the
    // point of the switch is that nothing AI-shaped is running, and gigabytes
    // of resident memory would make a liar of it.
    if (!enabled) await engine.stop()
    return appState.setAiEnabled(enabled)
  })
  handle('app:setEmbeddedIdleMinutes', ({ minutes }) => {
    engine.setIdleMs(minutes * 60_000)
    return appState.setEmbeddedIdleMinutes(minutes)
  })
  handle('app:setStatsIdleTimeoutMinutes', ({ minutes }) => appState.setStatsIdleTimeoutMinutes(minutes))

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

  handle('templates:applyPreset', ({ templateId }) => templates.presetStylesAndPage(templateId))

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
      // Review threads anchor the same way notes do and go stale the same way,
      // so they are re-checked on the same save rather than on a timer.
      await session.reviews.reconcile(doc.docId, doc.content).catch(() => {})
      reviewChanged(event, doc.docId)
      const highlightsReconciled = await session.highlights.reconcile(doc.docId, doc.content).catch(() => null)
      if (highlightsReconciled) highlightChanged(event, doc.docId)
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
  /**
   * Read `.bib`/`.ris` files off the local disk and merge what they hold.
   *
   * `fs` directly rather than the project's `VfsAdapter`, deliberately: these
   * are files being imported *from* the machine, chosen in a native file
   * dialog, and have nothing to do with where the project itself lives — the
   * same reason `docx:import` takes absolute paths.
   *
   * The format is chosen by extension, falling back to sniffing the contents,
   * because a file saved as `references.txt` from a browser is common and
   * refusing it on the name alone would be unhelpful.
   */
  const importSourceFiles = async (
    session: ProjectSession,
    files: string[]
  ): Promise<IpcRes<'sources:import'>> => {
    const items: CslItem[] = []
    const warnings: string[] = []

    for (const file of files) {
      let text: string
      try {
        text = await fs.readFile(file, 'utf8')
      } catch {
        warnings.push(`Could not read ${path.basename(file)}.`)
        continue
      }

      const extension = path.extname(file).toLowerCase()
      const looksRis = /^\s*TY {2}-/m.test(text)
      const parsed =
        extension === '.ris' || (extension !== '.bib' && extension !== '.bibtex' && looksRis)
          ? parseRis(text)
          : parseBibtex(text)

      if (parsed.items.length === 0 && parsed.warnings.length === 0) {
        warnings.push(`${path.basename(file)} held no references this build could read.`)
      }
      items.push(...parsed.items)
      warnings.push(...parsed.warnings.map((warning) => `${path.basename(file)}: ${warning}`))
    }

    const merged = await session.sources.merge(items)
    return { ...merged, warnings }
  }

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

  handle('epub:export', async ({ paths, items, file }, event) => {
    const session = requireSession(event)
    await session.epub.export(resolveExportItems(paths, items), file, session.manifest)
    return { ok: true as const, file }
  })

  handle('epub:exportDialog', async ({ paths, items, suggestedName }, event) => {
    const session = requireSession(event)
    const window = BrowserWindow.fromWebContents(event.sender)
    const suggested = `${suggestedName ?? defaultExportName(paths)}.epub`
    const picked = await dialog.showSaveDialog(window!, {
      title: 'Export to EPUB',
      defaultPath: suggested,
      filters: [{ name: 'EPUB', extensions: ['epub'] }]
    })
    if (picked.canceled || !picked.filePath) return null
    await session.epub.export(resolveExportItems(paths, items), picked.filePath, session.manifest)
    return { ok: true as const, file: picked.filePath }
  })

  /**
   * `publish:export`/`publish:exportDialog` dispatch to the same per-format
   * service the older, still-live `docx:export`/`epub:export`/
   * `fountain:export` channels call — one body shared by both entry points,
   * so a bug fixed here is fixed for every caller rather than one at a time.
   */
  const runPublishExport = async (
    session: ProjectSession,
    format: PublishFormat,
    paths: string[],
    items: ExportItem[],
    sourcePath: string | undefined,
    file: string
  ): Promise<void> => {
    switch (format) {
      case 'docx':
        return session.docx.export(resolveExportItems(paths, items), file, session.manifest)
      case 'epub':
        return session.epub.export(resolveExportItems(paths, items), file, session.manifest)
      case 'fountain':
        if (!sourcePath) throw new Error('Fountain export needs a document path')
        return session.fountain.export(sourcePath, file)
      case 'pdf':
        return session.print.exportPdf(resolveExportItems(paths, items), file, session.manifest)
      case 'print':
        // `print` has no file to save; `publish:export`/`publish:exportDialog`
        // reuse the same request shape for it anyway (the renderer's dialog
        // is one control for every format) and simply ignore `file`.
        return session.print.print(resolveExportItems(paths, items), session.manifest)
    }
  }

  const publishExtension: Record<PublishFormat, string> = {
    docx: 'docx',
    epub: 'epub',
    fountain: 'fountain',
    pdf: 'pdf',
    print: 'pdf'
  }
  const publishDialogTitle: Record<PublishFormat, string> = {
    docx: 'Export to Word',
    epub: 'Export to EPUB',
    fountain: 'Export to Fountain',
    pdf: 'Export to PDF',
    print: 'Print'
  }

  handle('publish:export', async ({ format, path: sourcePath, paths, items, file }, event) => {
    const session = requireSession(event)
    await runPublishExport(session, format, paths, items, sourcePath, file)
    return { ok: true as const, file }
  })

  handle('publish:exportDialog', async ({ format, path: sourcePath, paths, items, suggestedName }, event) => {
    const session = requireSession(event)
    if (format === 'print') {
      await runPublishExport(session, format, paths, items, sourcePath, '')
      return { ok: true as const, file: '' }
    }
    const window = BrowserWindow.fromWebContents(event.sender)
    const extension = publishExtension[format]
    const suggested = `${suggestedName ?? defaultExportName(sourcePath ? [sourcePath] : paths)}.${extension}`
    const picked = await dialog.showSaveDialog(window!, {
      title: publishDialogTitle[format],
      defaultPath: suggested,
      filters: [{ name: publishDialogTitle[format], extensions: [extension] }]
    })
    if (picked.canceled || !picked.filePath) return null
    await runPublishExport(session, format, paths, items, sourcePath, picked.filePath)
    return { ok: true as const, file: picked.filePath }
  })

  handle('publish:warnings', ({ format }, event) => {
    return exportWarnings(format, requireSession(event).manifest)
  })

  /** Mirrors `importDocxFiles` — see its own comment. */
  const importFountainFiles = async (
    session: ProjectSession,
    files: string[],
    targetDir: string
  ): Promise<IpcRes<'fountain:import'>> => {
    const result = await session.fountain.import(files, targetDir)
    for (const document of result.imported) {
      await session.search.indexDocument(document.path).catch(() => {})
    }
    return result
  }

  handle('fountain:import', ({ files, targetDir }, event) =>
    importFountainFiles(requireSession(event), files, targetDir)
  )

  handle('fountain:importDialog', async ({ targetDir }, event) => {
    const session = requireSession(event)
    const window = BrowserWindow.fromWebContents(event.sender)
    const picked = await dialog.showOpenDialog(window!, {
      title: 'Import Fountain screenplays',
      filters: [{ name: 'Fountain', extensions: ['fountain'] }],
      properties: ['openFile', 'multiSelections']
    })
    if (picked.canceled || picked.filePaths.length === 0) return null
    return importFountainFiles(session, picked.filePaths, targetDir)
  })

  handle('fountain:export', async ({ path: sourcePath, file }, event) => {
    await requireSession(event).fountain.export(sourcePath, file)
    return { ok: true as const, file }
  })

  handle('fountain:exportDialog', async ({ path: sourcePath, suggestedName }, event) => {
    const session = requireSession(event)
    const window = BrowserWindow.fromWebContents(event.sender)
    const suggested = `${suggestedName ?? defaultExportName([sourcePath])}.fountain`
    const picked = await dialog.showSaveDialog(window!, {
      title: 'Export to Fountain',
      defaultPath: suggested,
      filters: [{ name: 'Fountain', extensions: ['fountain'] }]
    })
    if (picked.canceled || !picked.filePath) return null
    await session.fountain.export(sourcePath, picked.filePath)
    return { ok: true as const, file: picked.filePath }
  })

  handle('search:query', (query, event) => requireSession(event).search.query(query))
  handle('search:status', (_payload, event) => requireSession(event).search.getProgress())
  handle('search:reindex', async (_payload, event) => {
    void requireSession(event).search.syncAll(true).catch(() => {})
    return { ok: true as const }
  })

  handle('spellcheck:setLanguage', ({ lang }, event) => {
    // An invalid or unsupported BCP-47 tag must not crash the whole app —
    // Electron throws for one Chromium's spellchecker doesn't recognise, and
    // the fallback is simply "keep whatever was set before".
    try {
      event.sender.session.setSpellCheckerLanguages([lang])
    } catch {
      // Deliberately ignored — see above.
    }
    return { ok: true as const }
  })
  handle('spellcheck:listWords', async (_payload, event) => requireSession(event).dictionary.load())
  handle('spellcheck:addWord', async ({ word }, event) => {
    const session = requireSession(event)
    const words = await session.dictionary.addWord(word)
    event.sender.session.addWordToSpellCheckerDictionary(word)
    return words
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

  handle('stats:list', (_req, event) => requireSession(event).stats.all())
  handle('stats:exportCsv', async ({ csv }, event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const picked = await dialog.showSaveDialog(window!, {
      title: 'Export writing stats',
      defaultPath: 'writing-stats.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (picked.canceled || !picked.filePath) return null
    await fs.writeFile(picked.filePath, csv, 'utf8')
    return { ok: true as const, file: picked.filePath }
  })
  handle('stats:record', async ({ date, docId, added, removed, net, minutes }, event) => {
    const ownerId = windows.ownerWindowId(event.sender)
    await requireSession(event).stats.record({ date, docId, added, removed, net, minutes })
    if (ownerId !== null) windows.sendToSession(ownerId, 'stats:changed', {})
    return { ok: true as const }
  })

  function highlightChanged(event: IpcMainInvokeEvent, docId: string): void {
    const ownerId = windows.ownerWindowId(event.sender)
    if (ownerId !== null) windows.sendToSession(ownerId, 'highlights:changed', { docId })
  }

  handle('highlights:list', ({ docId }, event) => requireSession(event).highlights.listForDoc(docId))
  handle('highlights:collect', async ({ docId, highlightId, color, quote, blockIndex, categoryId }, event) => {
    const collected = await requireSession(event).highlights.collect(docId, highlightId, {
      color,
      quote,
      blockIndex,
      categoryId
    })
    highlightChanged(event, docId)
    return collected
  })
  handle('highlights:save', async ({ docId, highlight }, event) => {
    const saved = await requireSession(event).highlights.save(docId, highlight)
    highlightChanged(event, docId)
    return saved
  })
  handle('highlights:delete', async ({ docId, id }, event) => {
    await requireSession(event).highlights.remove(docId, id)
    highlightChanged(event, docId)
    return { ok: true as const }
  })

  function reviewChanged(event: IpcMainInvokeEvent, docId: string): void {
    const ownerId = windows.ownerWindowId(event.sender)
    if (ownerId !== null) windows.sendToSession(ownerId, 'review:changed', { docId })
  }

  handle('review:list', async ({ docId }, event) => {
    const session = requireSession(event)
    // Always re-read: a collaborator's file arrives by sync, not by anything
    // this window did, so a cache trusted across calls would show yesterday's
    // discussion.
    session.reviews.invalidate(docId)
    return session.reviews.list(docId)
  })
  handle('review:createThread', async ({ docId, anchorId, anchorText, blockIndex }, event) => {
    const thread = await requireSession(event).reviews.createThread(docId, anchorId, anchorText, blockIndex)
    reviewChanged(event, docId)
    return thread
  })
  handle('review:saveThread', async ({ docId, thread }, event) => {
    await requireSession(event).reviews.patchThread(docId, thread.id, thread)
    reviewChanged(event, docId)
    return { ok: true as const }
  })
  handle('review:setStatus', async ({ docId, threadId, status }, event) => {
    await requireSession(event).reviews.setStatus(docId, threadId, status)
    reviewChanged(event, docId)
    return { ok: true as const }
  })
  handle('review:deleteThread', async ({ docId, threadId }, event) => {
    await requireSession(event).reviews.removeThread(docId, threadId)
    reviewChanged(event, docId)
    return { ok: true as const }
  })
  handle('review:reply', async ({ docId, threadId, text }, event) => {
    const reply = await requireSession(event).reviews.reply(docId, threadId, text)
    reviewChanged(event, docId)
    return reply
  })
  handle('review:saveReply', async ({ docId, reply }, event) => {
    await requireSession(event).reviews.patchReply(docId, reply.id, reply)
    reviewChanged(event, docId)
    return { ok: true as const }
  })
  handle('review:deleteReply', async ({ docId, replyId }, event) => {
    await requireSession(event).reviews.removeReply(docId, replyId)
    reviewChanged(event, docId)
    return { ok: true as const }
  })
  handle('review:authors', async (_payload, event) => {
    const session = requireSession(event)
    session.reviews.invalidateAuthors()
    return session.reviews.listAuthors()
  })
  handle('review:me', () => appState.author())
  handle('review:setMe', async (changes, event) => {
    const profile = appState.setAuthor(changes).author
    const me = appState.author()
    // Record the new name in the project so collaborators see it, if one is
    // open — naming yourself from the welcome screen is perfectly ordinary.
    const ownerId = windows.ownerWindowId(event.sender)
    const session = ownerId === null ? undefined : sessions.get(ownerId)
    await session?.reviews.registerAuthor(me).catch(() => {})
    return { ...me, name: profile.name }
  })
  handle('review:presence', ({ docId }, event) => requireSession(event).presence.list(docId))
  handle('review:enter', ({ docId }, event) => {
    requireSession(event).presence.enter(docId)
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
  handle('sources:import', ({ files }, event) => importSourceFiles(requireSession(event), files))
  handle('sources:importDialog', async (_payload, event) => {
    const session = requireSession(event)
    const window = BrowserWindow.fromWebContents(event.sender)
    const picked = await dialog.showOpenDialog(window!, {
      title: 'Import sources',
      filters: [
        { name: 'Bibliography files', extensions: ['bib', 'bibtex', 'ris'] },
        { name: 'BibTeX', extensions: ['bib', 'bibtex'] },
        { name: 'RIS', extensions: ['ris'] }
      ],
      properties: ['openFile', 'multiSelections']
    })
    if (picked.canceled || picked.filePaths.length === 0) return null
    return importSourceFiles(session, picked.filePaths)
  })
  handle('sources:lookup', async ({ query }, event) => {
    const session = requireSession(event)
    const result = await lookupSource(query)
    if (!result.ok) return result
    await session.sources.merge([result.item])
    return result
  })

  handle('research:attachments:list', ({ sourceId }, event) =>
    requireSession(event).sources.listAttachments(sourceId)
  )
  handle('research:attachments:addPdf', ({ sourceId, bytesBase64, label }, event) =>
    requireSession(event).sources.addPdfAttachment(sourceId, Buffer.from(bytesBase64, 'base64'), label)
  )
  handle('research:attachments:addCapture', ({ sourceId, capture, label }, event) =>
    requireSession(event).sources.addCaptureAttachment(sourceId, capture, label)
  )
  handle('research:attachments:remove', async ({ sourceId, attachmentId }, event) => {
    await requireSession(event).sources.removeAttachment(sourceId, attachmentId)
    return { ok: true as const }
  })
  handle('research:attachments:readPdf', async ({ sourceId, attachmentId }, event) => {
    const bytes = await requireSession(event).sources.readPdfAttachment(sourceId, attachmentId)
    return { bytesBase64: bytes.toString('base64') }
  })
  handle('research:attachments:readCapture', ({ sourceId, attachmentId }, event) =>
    requireSession(event).sources.readCapture(sourceId, attachmentId)
  )
  handle('research:capture', async ({ url }, event) => {
    requireSession(event) // a project must be open, even though capture itself is project-agnostic
    return capturePage(url, (target) => fetch(target))
  })

  function researchHighlightChanged(event: IpcMainInvokeEvent, sourceId: string, attachmentId: string): void {
    const ownerId = windows.ownerWindowId(event.sender)
    if (ownerId !== null) windows.sendToSession(ownerId, 'research:highlights:changed', { sourceId, attachmentId })
  }

  handle('research:highlights:list', ({ sourceId, attachmentId }, event) =>
    requireSession(event).pdfHighlights.listForAttachment(sourceId, attachmentId)
  )
  handle('research:highlights:save', async ({ sourceId, attachmentId, highlight }, event) => {
    const saved = await requireSession(event).pdfHighlights.save(sourceId, attachmentId, highlight)
    researchHighlightChanged(event, sourceId, attachmentId)
    return saved
  })
  handle('research:highlights:delete', async ({ sourceId, attachmentId, id }, event) => {
    await requireSession(event).pdfHighlights.remove(sourceId, attachmentId, id)
    researchHighlightChanged(event, sourceId, attachmentId)
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

  /**
   * Get the embedded model running, and say where to send.
   *
   * Absent weights fail here rather than starting a download: pressing send is
   * never what begins a 16 GB transfer, and the panel turns this message into
   * the affordance that does.
   */
  async function startEmbedded(model: string): Promise<string> {
    if (!engine.available()) {
      throw new Error('This build has no embedded model runtime for your platform.')
    }

    if (isSideloadedModel(model)) {
      const file = models.resolveSideloaded(model)
      if (!file) throw new Error(`No model file at ${model}.`)
      const url = await engine.ensure({
        modelPath: file,
        modelId: model,
        contextLength: DEFAULT_SIDELOAD_CONTEXT
      })
      if (!url) throw new Error(engine.status().message || 'The embedded model could not start.')
      return url
    }

    const variant = resolveVariant(model)
    if (!variant) throw new Error(`"${model}" is not a model this build knows about.`)

    const file = models.resolve(variant.id)
    if (!file) {
      throw new Error(`${variant.label} is not downloaded yet. Download it in the AI settings.`)
    }

    const url = await engine.ensure({
      modelPath: file,
      modelId: variant.id,
      contextLength: variant.contextLength
    })
    if (!url) throw new Error(engine.status().message || 'The embedded model could not start.')
    return url
  }

  /**
   * Find something to embed with, or say why there is nothing.
   *
   * `allowStart` is the whole of the policy. A person who pressed Build has
   * asked for this and may be charged a model load or a hosted API call for it;
   * the background top-up that runs when a project opens has asked for nothing,
   * and gets an embedder only if one is already there and free. That is what
   * keeps a manuscript from being quietly posted to a paid endpoint, and a
   * laptop from warming up for reasons its owner cannot account for.
   */
  async function resolveEmbedder(ownerId: number, allowStart: boolean): Promise<EmbedderResolution> {
    if (!appState.get().aiEnabled) {
      return { embedder: null, unavailable: 'AI features are turned off.' }
    }
    const session = sessions.get(ownerId)
    if (!session) return { embedder: null, unavailable: 'No project is open.' }

    const settings = resolveSettings(session.chats.settings())
    const info = providerInfo(settings.provider)
    const apiKey = keys.get(settings.provider)
    if (info.needsKey && !apiKey) {
      return { embedder: null, unavailable: `No API key is set for ${info.name}.` }
    }

    let baseUrl = settings.baseUrl
    if (settings.provider === 'embedded') {
      const running = engine.runningUrl()
      if (!running && !allowStart) {
        return {
          embedder: null,
          unavailable: 'The embedded model is not running. Build the index to start it.'
        }
      }
      if (running) baseUrl = running
      else {
        try {
          baseUrl = await startEmbedded(settings.model)
        } catch (error) {
          return { embedder: null, unavailable: error instanceof Error ? error.message : String(error) }
        }
      }
    } else if (info.needsKey && !allowStart) {
      return {
        embedder: null,
        unavailable: `Indexing with ${info.name} sends your manuscript to them, so it only happens when you ask for it.`
      }
    }

    const config = embedderConfig({ ...settings, baseUrl }, apiKey)
    const refusal = embedderRefusal(config, info.name)
    if (refusal) return { embedder: null, unavailable: refusal }
    return { embedder: new Embedder(config), unavailable: '' }
  }

  /** Search this project by meaning, for the agent's `find_passages` tool. */
  async function findPassages(
    ownerId: number,
    session: ProjectSession,
    query: string,
    limit: number
  ): Promise<RetrievalResult> {
    const coverage = session.search.embeddingCoverage()
    // Allowed to start, because a person asked a question and is waiting: this
    // runs inside a reply they are watching stream, not in the background.
    const { embedder } = await resolveEmbedder(ownerId, true)
    if (!embedder) return { hits: [], ...coverage }
    const [vector] = await embedder.embed([query])
    if (!vector) return { hits: [], ...coverage }
    return { hits: session.search.nearestBlocks(vector, limit), ...coverage }
  }

  handle('ai:retrievalStatus', (_payload, event) => requireSession(event).retrieval.status())
  handle('ai:buildRetrieval', (_payload, event) => requireSession(event).retrieval.build(true))
  /**
   * Today's writing prompt for the welcome screen.
   *
   * Cached per day in app state, so opening the app four times in a morning
   * costs one request rather than four — and so the prompt a writer read at
   * breakfast is still there at lunch, which is most of what makes it feel like
   * a thing rather than a slot machine.
   *
   * Every unavailable case returns an empty prompt rather than throwing: the
   * welcome screen is not a place to show an error about a feature nobody asked
   * for, and the card simply does not appear.
   */
  handle('ai:dailyPrompt', async ({ refresh }, event) => {
    const stored = appState.get().dailyPrompt
    if (!refresh && isFresh(stored)) return stored
    if (!appState.get().aiEnabled) return EMPTY_DAILY_PROMPT

    const ownerId = windows.ownerWindowId(event.sender)
    const session = ownerId === null ? undefined : sessions.get(ownerId)
    const settings = resolveSettings(session?.chats.settings() ?? aiSettingsSchema.parse({}))
    const info = providerInfo(settings.provider)
    const apiKey = keys.get(settings.provider)
    if (info.needsKey && !apiKey) return EMPTY_DAILY_PROMPT

    let baseUrl = settings.baseUrl
    if (settings.provider === 'embedded') {
      // Never downloads and never waits on a cold start here: an app that
      // fetched gigabytes because someone opened the welcome screen would be an
      // app people learn to avoid opening.
      const running = engine.runningUrl()
      if (!running) return EMPTY_DAILY_PROMPT
      baseUrl = running
    }

    const angle = pickAngle(stored.angle)
    const outcome = await streamCompletion(
      {
        settings: { ...settings, baseUrl, maxTokens: 200 },
        system: 'You write short, concrete writing prompts.',
        messages: [{ role: 'user', text: promptRequest(angle) }],
        apiKey
      },
      AbortSignal.timeout(PROMPT_TIMEOUT_MS),
      () => {}
    ).catch(() => null)

    const text = outcome?.text.trim() ?? ''
    if (!text || outcome?.error) return EMPTY_DAILY_PROMPT
    return appState.setDailyPrompt({ date: today(), text, angle })
  })

  handle('ai:cancelRetrieval', (_payload, event) => {
    requireSession(event).retrieval.cancel()
    return { ok: true as const }
  })

  handle('llm:status', async () => ({
    variants: await models.status(),
    engine: engine.status(),
    totalMemoryBytes: os.totalmem(),
    runtimeAvailable: engine.available()
  }))

  handle('llm:download', async ({ variantId }, event) => {
    const ownerId = windows.ownerWindowId(event.sender)
    const emit = (progress: LlmProgress): void => {
      // Broadcast rather than sent to one window: a download belongs to the
      // app, and a second window with the manager open should see it move.
      if (ownerId !== null) windows.sendToSession(ownerId, 'llm:progress', progress)
    }

    const result = await models.download(variantId, (receivedBytes, totalBytes) =>
      emit({ variantId, receivedBytes, totalBytes, done: false, error: '' })
    )
    emit({
      variantId,
      receivedBytes: result.bytes,
      totalBytes: result.bytes,
      done: true,
      error: result.error ?? ''
    })
    return { ok: result.ok, error: result.error ?? '' }
  })

  handle('llm:cancelDownload', ({ variantId }) => {
    models.cancel(variantId)
    return { ok: true as const }
  })

  handle('llm:chooseFile', async (_payload, event) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
      title: 'Choose a model file',
      message: 'Choose a .gguf model file already on this computer',
      buttonLabel: 'Use this model',
      properties: ['openFile'],
      filters: [{ name: 'Model weights', extensions: ['gguf'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return { path: result.filePaths[0]! }
  })

  handle('llm:remove', async ({ variantId }) => {
    // Stop it before deleting the file underneath it.
    if (engine.status().model === variantId) await engine.stop()
    await models.remove(variantId)
    return { ok: true as const }
  })

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

    // Defence in depth. The renderer registers no AI surface when this is off,
    // so reaching here means something bypassed the UI — a stale popout, or a
    // caller that should not exist.
    if (!appState.get().aiEnabled) throw new Error('AI features are turned off.')

    let settings = resolveSettings(session.chats.settings(), chat.settings)
    const info = providerInfo(settings.provider)
    const apiKey = keys.get(settings.provider)
    if (info.needsKey && !apiKey) {
      throw new Error(`No API key is set for ${info.name}. Add one in the AI panel's settings.`)
    }

    if (settings.provider === 'embedded') {
      settings = { ...settings, baseUrl: await startEmbedded(settings.model) }
    }

    const body = attached.trim() ? `${text}\n\n---\n${attached.trim()}` : text
    const message: ChatMessage = {
      id: ulid(),
      role: 'user',
      text: body,
      model: '',
      toolCalls: [],
      created: new Date().toISOString()
    }
    const updated = await session.chats.append(chatId, message)
    if (!updated) throw new Error('That chat no longer exists')

    const requestId = ulid()
    const ownerId = windows.ownerWindowId(event.sender)
    const onEvent = (streamEvent: StreamEvent): void => {
      if (ownerId !== null) windows.sendToSession(ownerId, 'ai:stream', streamEvent)
      // A generation in progress is not an idle app, however long it runs.
      if (settings.provider === 'embedded') engine.keepAlive()
      // Persist only the finished reply: writing every delta would rewrite the
      // whole chat file on each token.
      if (streamEvent.type === 'done') {
        void session.chats.append(chatId, streamEvent.message).catch(() => {})
        // The moment a model is warm is the cheapest moment to embed, so a
        // finished reply is what tops the index up. Still `false`: this is the
        // app noticing an opportunity, not the writer asking.
        void session.retrieval.build(false).catch(() => {})
      }
    }

    const run = {
      requestId,
      settings,
      system: settings.systemPrompt,
      messages: updated.messages.map((item) => ({
        role: item.role,
        text: item.text
      })),
      apiKey,
      onEvent
    }

    // An ordinary question costs one request; only an agent run loops. Which
    // path a message takes is the writer's setting, not a guess about intent.
    // Offered only when there is something to search. A project with an empty
    // index gets the keyword tools and no mention of the other, rather than a
    // tool the model spends a step calling to be told it is useless.
    const indexed = session.search.embeddingCoverage().embedded > 0
    const started = settings.agent
      ? runAgent(session.ai, {
          ...run,
          session,
          ...(indexed && ownerId !== null
            ? { findPassages: (query: string, limit: number) => findPassages(ownerId, session, query, limit) }
            : {})
        })
      : session.ai.run(run)
    void started.catch(() => {})

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
      return { ok: false, message: 'That server is no longer saved.', entries: 0, hostKey: null, needsCreate: false }
    }

    /*
     * A database asks a different question.
     *
     * "Reachable, but holding no project" is not a failure — the server is fine
     * and the tables are simply not there — so it comes back as an offer to
     * create them rather than as an error the writer has to interpret.
     */
    if (profile.protocol === 'db') {
      try {
        const { exists, tooNew } = await inspectDatabase(profile.id)
        if (tooNew) {
          return {
            ok: false,
            message: 'That database holds a project written by a newer version of The Pub.',
            entries: 0,
            hostKey: null,
            needsCreate: false
          }
        }
        return {
          ok: true,
          message: exists
            ? `Connected. A project is already here in the "${profile.schema}" schema.`
            : `Connected. There is no project here yet — one can be created in the "${profile.schema}" schema.`,
          entries: 0,
          hostKey: null,
          needsCreate: !exists
        }
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
          entries: 0,
          hostKey: null,
          needsCreate: false
        }
      }
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
      return { ok: true, message: `Connected to ${where}.`, entries: entries.length, hostKey: null, needsCreate: false }
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
          : null,
        needsCreate: false
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
  handle('connections:createDatabase', async ({ id }) => {
    try {
      await createDatabaseProject(id)
      return { ok: true, message: 'The project tables have been created.' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })

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

  handle('connections:cancelSignIn', ({ id }) => {
    oneDrive.cancel(id)
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
}

/** Human-readable project name for a folder path, used before a manifest exists. */
export function projectNameFor(uri: string): string {
  return path.basename(uri)
}
