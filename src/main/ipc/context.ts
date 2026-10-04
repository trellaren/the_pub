import { ipcMain, dialog, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { ipcContract, type IpcInvokeChannel, type IpcReq, type IpcRes } from '../../shared/ipc/contract.js'
import type { WindowManager } from '../windows/windowManager.js'
import type { AppStateService } from '../services/appState.js'
import { ProjectSession } from '../services/projectSession.js'
import { AiKeyStore, originOf } from '../services/aiKeyStore.js'
import type { OneDriveAuth } from '../services/oneDriveAuth.js'
import type { TemplateService } from '../services/templateService.js'
import type { RendererServerLike } from '../print/printService.js'
import type { ModelStore } from '../llm/modelStore.js'
import type { LlmEngine } from '../llm/engine.js'
import type { KeyId } from '../../shared/model/webAccess.js'
import type { PubDocument } from '../../shared/model/document.js'
import { validateRelativePath } from '../../shared/model/filename.js'
import type { EmbedderResolution } from '../ai/embeddingIndexer.js'
import { resolveEmbedder as resolveEmbedderFor, startEmbedded as startEmbeddedWith } from '../ai/embeddedRuntime.js'

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
  /**
   * Swap in the session `open` produces, closing the previous one only once
   * that has succeeded — a failed open must leave the window on a project that
   * still works, not on a closed one whose every save fails.
   *
   * Reopening the same project is the exception: two sessions on one folder
   * would share its index database and double every watcher event, so the old
   * session goes first and a failure leaves the window with no project.
   */
  async replace(ownerId: number, uri: string, open: () => Promise<ProjectSession>): Promise<ProjectSession> {
    if (this.sessions.get(ownerId)?.uri === uri) await this.close(ownerId)
    const session = await open()
    const previous = this.sessions.get(ownerId)
    this.sessions.set(ownerId, session)
    if (previous && previous !== session) await previous.close().catch(() => {})
    return session
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

export interface HandlerDeps {
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

export type Handle = <K extends IpcInvokeChannel>(
  channel: K,
  implementation: (payload: IpcReq<K>, event: IpcMainInvokeEvent) => Promise<IpcRes<K>> | IpcRes<K>
) => void

export interface HandlerContext extends HandlerDeps {
  handle: Handle
  keys: AiKeyStore
  keyFor(
    id: KeyId,
    url: string,
    defaultUrl: string,
    name: string,
    asker?: IpcMainInvokeEvent | number
  ): Promise<string | null>
  requireSession(event: IpcMainInvokeEvent): ProjectSession
  /** The window a dialog should be parented to: the one the request came from. */
  ownerWindow(event: IpcMainInvokeEvent): BrowserWindow
  /** Files chosen in a native picker over the requesting window, or null if cancelled. */
  pickFiles(
    event: IpcMainInvokeEvent,
    options: { title: string; filters: Electron.FileFilter[]; multiple?: boolean }
  ): Promise<string[] | null>
  openInto(ownerId: number, uri: string): Promise<ProjectSession>
  commitDocumentWrite(
    event: IpcMainInvokeEvent,
    target: string,
    doc: PubDocument,
    expectedMtime: number | null
  ): Promise<IpcRes<'doc:write'>>
  rescan(event: IpcMainInvokeEvent): void
  noteChanged(event: IpcMainInvokeEvent, docId: string): void
  reviewChanged(event: IpcMainInvokeEvent, docId: string): void
  highlightChanged(event: IpcMainInvokeEvent, docId: string): void
  resolveEmbedder(ownerId: number, allowStart: boolean): Promise<EmbedderResolution>
  startEmbedded(model: string): Promise<string>
}

/**
 * Refuse a name no Windows filesystem can hold.
 *
 * Checked here rather than in the adapter so every backend gets it: a project
 * served over SFTP from a Linux host is routinely opened on Windows, and a name
 * that works for the author who typed it and fails for their collaborator is
 * the worst of both. The message is written to be shown verbatim.
 */
export function requirePortableName(target: string): void {
  const result = validateRelativePath(target)
  if (!result.ok) throw new Error(result.reason)
}

export function createHandlerContext(deps: HandlerDeps): HandlerContext {
  const { windows, sessions, appState, models, engine, rendererServer } = deps
  // App-wide, not per project: a key belongs to the person, not the manuscript.
  const keys = new AiKeyStore()

  /**
   * Bind a contract channel. The request is parsed with the channel's schema
   * before the implementation sees it, so handlers never guard their own inputs
   * and a malformed payload fails at the boundary with a useful message.
   */
  const handle: Handle = (channel, implementation) => {
    ipcMain.handle(channel, async (event, raw) => {
      // Only our own pages may call in. Nothing embeds a frame today; this keeps
      // a future iframe or webview from inheriting the whole IPC surface.
      const frameUrl = event.senderFrame?.url
      if (!frameUrl || !windows.isInternalUrl(frameUrl)) {
        throw new Error(`Refused ${channel} from ${frameUrl ?? 'an unknown frame'}`)
      }
      const parsed = ipcContract.invoke[channel].req.parse(raw ?? {}) as IpcReq<typeof channel>
      return implementation(parsed, event)
    })
  }

  /**
   * The stored key for a provider, bound to where it is about to be sent. A
   * renderer-chosen base URL on a host other than the provider's own only gets
   * the key once the author confirms that host in a dialog main draws — the
   * renderer cannot answer it for them.
   *
   * `asker` is the request or window the dialog belongs to. Without one —
   * background work nobody just asked for — an unconfirmed host gets no key
   * and no dialog either.
   */
  async function keyFor(
    id: KeyId,
    url: string,
    defaultUrl: string,
    name: string,
    asker?: IpcMainInvokeEvent | number
  ): Promise<string | null> {
    const bound = keys.getFor(id, url, defaultUrl)
    if (bound || !keys.get(id)) return bound
    const origin = originOf(url)
    const window =
      asker === undefined
        ? null
        : typeof asker === 'number'
          ? BrowserWindow.fromId(asker)
          : BrowserWindow.fromWebContents(asker.sender)
    if (!origin || !window) return null
    const { response } = await dialog.showMessageBox(window, {
      type: 'warning',
      buttons: ['Send key', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Send your ${name} key to ${origin}?`,
      detail: `This is not ${name}'s own server. Only continue if you set this address yourself.`
    })
    if (response !== 0) return null
    keys.trustHost(id, url)
    return keys.get(id)
  }

  /** Resolve the calling window's project, or fail loudly — there is no default. */
  function requireSession(event: IpcMainInvokeEvent): ProjectSession {
    const ownerId = windows.ownerWindowId(event.sender)
    const session = ownerId === null ? undefined : sessions.get(ownerId)
    if (!session) throw new Error('No project is open in this window')
    return session
  }

  function ownerWindow(event: IpcMainInvokeEvent): BrowserWindow {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) throw new Error('This request did not come from a window that can show a dialog')
    return window
  }

  async function pickFiles(
    event: IpcMainInvokeEvent,
    { title, filters, multiple = true }: { title: string; filters: Electron.FileFilter[]; multiple?: boolean }
  ): Promise<string[] | null> {
    const picked = await dialog.showOpenDialog(ownerWindow(event), {
      title,
      filters,
      properties: multiple ? ['openFile', 'multiSelections'] : ['openFile']
    })
    return picked.canceled || picked.filePaths.length === 0 ? null : picked.filePaths
  }

  function notify(event: IpcMainInvokeEvent, send: (ownerId: number) => void): void {
    const ownerId = windows.ownerWindowId(event.sender)
    if (ownerId !== null) send(ownerId)
  }
  const noteChanged = (event: IpcMainInvokeEvent, docId: string): void =>
    notify(event, (ownerId) => windows.sendToSession(ownerId, 'notes:changed', { docId }))
  const reviewChanged = (event: IpcMainInvokeEvent, docId: string): void =>
    notify(event, (ownerId) => windows.sendToSession(ownerId, 'review:changed', { docId }))
  const highlightChanged = (event: IpcMainInvokeEvent, docId: string): void =>
    notify(event, (ownerId) => windows.sendToSession(ownerId, 'highlights:changed', { docId }))

  /**
   * Re-scan suggestions after a change to the records, and tell the window's
   * backlink lists to refetch. Confirmed mentions are untouched by this, so a
   * rename costs no file reads at all.
   */
  function rescan(event: IpcMainInvokeEvent): void {
    const session = requireSession(event)
    session.search.invalidateRoster()
    session.search.rescanSuggestions()
    notify(event, (ownerId) => windows.sendToSession(ownerId, 'mentions:changed', {}))
  }

  /**
   * The one way a document reaches disk from a handler.
   *
   * Everything that has to follow a write — the search index, and the notes,
   * review threads and highlights whose anchors may have moved — happens here,
   * so a second writer (the assistant applying an edit to a closed document)
   * cannot forget a step the editor's own save remembers.
   */
  async function commitDocumentWrite(
    event: IpcMainInvokeEvent,
    target: string,
    doc: PubDocument,
    expectedMtime: number | null
  ): Promise<IpcRes<'doc:write'>> {
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
  }

  const startEmbedded = (model: string): Promise<string> => startEmbeddedWith({ engine, models }, model)
  const resolveEmbedder = (ownerId: number, allowStart: boolean): Promise<EmbedderResolution> =>
    resolveEmbedderFor(
      { engine, models, appState, sessions, keyFor, hasKey: (id) => keys.get(id) !== null },
      ownerId,
      allowStart
    )

  /**
   * One open at a time per window. Two overlapping opens — a double-click on a
   * recent project — would each close, each open, and the second `set` would
   * drop the first session without closing it: its watcher, index database and
   * server connection left running for the life of the app.
   */
  const opening = new Map<number, Promise<unknown>>()
  function openInto(ownerId: number, uri: string): Promise<ProjectSession> {
    const previous = opening.get(ownerId) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(() => openIntoNow(ownerId, uri))
    opening.set(ownerId, next)
    void next.finally(() => {
      if (opening.get(ownerId) === next) opening.delete(ownerId)
    }).catch(() => {})
    return next
  }

  async function openIntoNow(ownerId: number, uri: string): Promise<ProjectSession> {
    const session = await sessions.replace(ownerId, uri, () =>
      ProjectSession.open(uri, {
        onFileChange: (events) => windows.sendToSession(ownerId, 'vfs:changed', events),
        onIndexProgress: (progress) => windows.sendToSession(ownerId, 'search:indexProgress', progress),
        resolveEmbedder: (allowStart) => resolveEmbedder(ownerId, allowStart),
        onRetrievalProgress: (status) => windows.sendToSession(ownerId, 'ai:retrievalProgress', status),
        author: () => appState.author(),
        rendererServer
      })
    )
    // Put ourselves in the project's registry on open, so a collaborator sees a
    // name against our comments rather than an id.
    await session.reviews.registerAuthor(appState.author()).catch(() => {})
    // And the assistant beside us, so its suggestions and comments carry a
    // name in the panel and in a Word export rather than an id.
    if (appState.get().aiEnabled) await session.reviews.registerAuthor(appState.assistant()).catch(() => {})
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
      window.setTitle(`${session.manifest.name} — Quoth`)
    }
    return session
  }

  return {
    ...deps,
    handle,
    keys,
    keyFor,
    requireSession,
    ownerWindow,
    pickFiles,
    openInto,
    commitDocumentWrite,
    rescan,
    noteChanged,
    reviewChanged,
    highlightChanged,
    resolveEmbedder,
    startEmbedded
  }
}
