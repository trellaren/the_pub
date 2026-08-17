import path from 'node:path'
import { createHash } from 'node:crypto'
import { app } from 'electron'
import { ulid } from 'ulid'
import type { VfsAdapter, Unwatch } from '../vfs/types.js'
import { createAdapter, parseUri } from '../vfs/vfsRegistry.js'
import { projectManifestSchema, type ProjectManifest, type OpenProject } from '../../shared/model/manifest.js'
import { migrate } from '../../shared/model/migrate.js'
import { BUILTIN_STYLES } from '../../shared/model/style.js'
import type { FileChangeEvent } from '../../shared/model/vfs.js'
import type { IndexProgress } from '../../shared/model/search.js'
import type { RetrievalStatus } from '../../shared/model/retrieval.js'
import type { AuthorProfile } from '../../shared/model/author.js'
import { DocumentService } from './documentService.js'
import { SnapshotService } from './snapshotService.js'
import { HistoryService } from './historyService.js'
import { SearchIndexService } from './searchIndexService.js'
import { LayoutService } from './layoutService.js'
import { EntityService } from './entityService.js'
import { NoteService } from './noteService.js'
import { HighlightService } from './highlightService.js'
import { PdfHighlightService } from './pdfHighlightService.js'
import { BeatService } from './beatService.js'
import { MapService } from './mapService.js'
import { SourceService } from './sourceService.js'
import { ManuscriptService } from './manuscriptService.js'
import { ChatService } from './chatService.js'
import { AiRunner } from '../ai/aiRunner.js'
import { EmbeddingIndexer, type EmbedderResolution } from '../ai/embeddingIndexer.js'
import { MentionService } from './mentionService.js'
import { ReviewService } from './reviewService.js'
import { PresenceService } from './presenceService.js'
import { DocxService } from './docxService.js'
import { EpubService } from './epubService.js'
import { FountainService } from './fountainService.js'
import { PrintService, type RendererServerLike } from '../print/printService.js'
import { MANIFEST_FILE, PUB_DIR, ASSETS_DIR, DOC_EXT, FORMAT_VERSIONS } from '../../shared/constants.js'

export interface SessionHooks {
  onFileChange: (events: FileChangeEvent[]) => void
  onIndexProgress: (progress: IndexProgress) => void
  /**
   * Reach an embedder for this project's current AI settings.
   *
   * A hook rather than a service the session builds: choosing one needs the
   * app's keys and the shared model engine, neither of which is scoped to a
   * project, and a session that could reach them would be a session that could
   * start a model on its own.
   */
  resolveEmbedder: (allowStart: boolean) => Promise<EmbedderResolution>
  onRetrievalProgress: (status: RetrievalStatus) => void
  /**
   * Who is using this app. A hook for the same reason `resolveEmbedder` is: the
   * identity lives in app state, outside any project, and a session that could
   * reach in and set it would be a session that could rewrite someone's id.
   */
  author: () => AuthorProfile
  /**
   * The app's loopback renderer server, when one is running — absent in
   * `npm run dev` (the Vite dev server serves the UI instead) and in tests.
   * `PrintService` falls back to a `data:` URL when this is undefined, so
   * PDF/print work either way; see its own comment.
   */
  rendererServer?: RendererServerLike
}

/**
 * Everything that makes up one open project: its backend, its manifest, and the
 * services scoped to it. A window owns exactly one session; popout windows share
 * their opener's.
 */
export class ProjectSession {
  readonly documents: DocumentService
  readonly snapshots: SnapshotService
  readonly history: HistoryService
  readonly search: SearchIndexService
  readonly layout: LayoutService
  readonly entities: EntityService
  readonly notes: NoteService
  readonly highlights: HighlightService
  readonly pdfHighlights: PdfHighlightService
  readonly beats: BeatService
  readonly maps: MapService
  readonly sources: SourceService
  readonly manuscript: ManuscriptService
  readonly chats: ChatService
  readonly ai = new AiRunner()
  readonly retrieval: EmbeddingIndexer
  readonly mentions: MentionService
  readonly reviews: ReviewService
  readonly presence: PresenceService
  readonly docx: DocxService
  readonly epub: EpubService
  readonly fountain: FountainService
  readonly print: PrintService
  /**
   * The opaque name asset URLs know this project by.
   *
   * Derived from the URI rather than minted per session, and that is the
   * load-bearing choice: `doc:writeAsset` URLs are written verbatim into
   * `.pubdoc` files, so a token that changed on restart would kill every image
   * inserted the day before. Hashing the URI is the move `indexDbPath` below
   * already makes, for the same reason — stable identity, no path disclosed.
   */
  readonly assetToken: string
  /** Local projects stream assets straight off disk; the rest go via the adapter. */
  readonly isLocal: boolean
  private unwatch: Unwatch | null = null

  private constructor(
    readonly uri: string,
    readonly adapter: VfsAdapter,
    public manifest: ProjectManifest,
    /**
     * The manifest on disk was written by a newer version of The Pub. Reading
     * it worked because the schema drops fields it doesn't know rather than
     * rejecting them, but writing it back would make that drop permanent —
     * so nothing in this session may save the manifest until the project is
     * next opened by a build that understands it.
     */
    readonly readOnly: boolean,
    private readonly hooks: SessionHooks
  ) {
    this.assetToken = createHash('sha256').update(uri).digest('hex').slice(0, 32)
    this.isLocal = parseUri(uri).scheme === 'local'
    this.snapshots = new SnapshotService(adapter)
    this.documents = new DocumentService(adapter, this.snapshots)
    this.layout = new LayoutService(adapter)
    this.entities = new EntityService(adapter)
    this.notes = new NoteService(adapter)
    this.highlights = new HighlightService(adapter)
    this.pdfHighlights = new PdfHighlightService(adapter)
    this.beats = new BeatService(adapter)
    this.maps = new MapService(adapter)
    this.sources = new SourceService(adapter)
    this.chats = new ChatService(adapter)
    this.search = new SearchIndexService(
      adapter,
      indexDbPath(uri, adapter.root),
      hooks.onIndexProgress,
      // A lambda, constructed before the service that reads it: the indexer
      // pulls the roster when it needs it rather than being handed one, so
      // there is no window in which it runs against an empty set.
      () => this.entities.snapshot()
    )
    // Same lambda-not-reference reasoning as the indexer's roster above: the
    // binder resolves against the index as it stands at the moment of the call,
    // so there is no window in which it resolves against nothing.
    this.manuscript = new ManuscriptService(adapter, {
      resolvePath: (docId) => this.search.resolvePath(docId),
      wordCountsFor: (docIds) => this.search.wordCountsFor(docIds),
      indexing: () => this.search.getProgress().indexing
    })
    this.retrieval = new EmbeddingIndexer({
      index: this.search,
      resolve: (allowStart) => hooks.resolveEmbedder(allowStart),
      onProgress: hooks.onRetrievalProgress
    })
    this.history = new HistoryService(this.documents, this.snapshots, this.search, this.notes)
    this.mentions = new MentionService(this.documents, this.search, this.entities)
    this.reviews = new ReviewService(adapter, hooks.author)
    this.presence = new PresenceService(adapter, hooks.author)
    this.docx = new DocxService(adapter, this.documents, this.reviews)
    this.epub = new EpubService(adapter, this.documents)
    this.fountain = new FountainService(adapter, this.documents)
    this.print = new PrintService(adapter, this.documents, hooks.rendererServer)
  }

  static async open(uri: string, hooks: SessionHooks): Promise<ProjectSession> {
    const adapter = createAdapter(uri)
    const { manifest, readOnly } = await loadOrCreateManifest(adapter)
    const session = new ProjectSession(uri, adapter, manifest, readOnly, hooks)
    await session.start()
    return session
  }

  private async start(): Promise<void> {
    await this.adapter.mkdir(ASSETS_DIR).catch(() => {})
    // Before the first index pass, so documents are scanned against the real
    // roster rather than an empty one.
    await this.entities.load().catch(() => {})
    await this.beats.load().catch(() => {})
    await this.maps.load().catch(() => {})
    await this.sources.load().catch(() => {})
    await this.chats.load().catch(() => {})
    await this.manuscript.load().catch(() => {})
    this.unwatch = await this.adapter.watch('', (events) => void this.handleFileChanges(events))
    // Index in the background: a large project must not delay the first paint.
    void this.search
      .syncAll()
      // Top up the retrieval index too, if that costs nothing surprising — the
      // hook refuses when embedding would load a model or reach a paid API.
      .then(() => this.retrieval.build(false))
      .catch(() => {})
  }

  private async handleFileChanges(events: FileChangeEvent[]): Promise<void> {
    for (const event of events) {
      if (!event.path.endsWith(DOC_EXT)) continue
      if (event.type === 'unlink') this.search.removeByPath(event.path)
      else if (event.type === 'add' || event.type === 'change') {
        await this.search.indexDocument(event.path).catch(() => {})
      }
    }
    this.hooks.onFileChange(events)
  }

  get root(): string {
    return this.adapter.root
  }

  toOpenProject(): OpenProject {
    return {
      uri: this.uri,
      root: this.adapter.root,
      assetToken: this.assetToken,
      isLocal: this.isLocal,
      manifest: this.manifest,
      readOnly: this.readOnly
    }
  }

  async saveManifest(manifest: ProjectManifest): Promise<ProjectManifest> {
    if (this.readOnly) {
      throw new Error('This project is read-only — its manifest was written by a newer version of The Pub.')
    }
    const next: ProjectManifest = { ...manifest, modified: new Date().toISOString() }
    await writeManifest(this.adapter, next)
    this.manifest = next
    return next
  }

  async close(): Promise<void> {
    if (this.unwatch) await this.unwatch()
    this.unwatch = null
    // Stop paying for replies nobody will read.
    this.ai.cancelAll()
    this.retrieval.cancel()
    // Before the adapter goes: leaving needs one last write.
    await this.presence.leave()
    this.search.close()
    await this.adapter.dispose()
  }
}

/** Where the rebuildable search cache lives. */
function indexDbPath(uri: string, root: string): string {
  const { scheme } = parseUri(uri)
  if (scheme === 'local') return path.join(root, PUB_DIR, 'index.db')
  // Remote projects keep the index locally: round-tripping every write over
  // SFTP or Graph would make indexing unusably slow.
  const digest = createHash('sha256').update(uri).digest('hex').slice(0, 16)
  return path.join(app.getPath('userData'), 'indexes', `${digest}.db`)
}

async function loadOrCreateManifest(
  adapter: VfsAdapter
): Promise<{ manifest: ProjectManifest; readOnly: boolean }> {
  const existing = await adapter.stat(MANIFEST_FILE)
  if (existing) {
    try {
      const raw = await adapter.readFile(MANIFEST_FILE)
      const { value, tooNew } = migrate('manifest', JSON.parse(raw.toString('utf8')))
      // A manifest ahead of what this build knows still parses today: the
      // schema drops fields it doesn't recognise rather than rejecting them.
      // That is exactly why it must not be saved back — see the constructor.
      return { manifest: projectManifestSchema.parse(value), readOnly: tooNew }
    } catch {
      // Keep the unreadable manifest rather than deleting it — it may hold
      // styles the author wants back — and continue with a fresh one. This is
      // reached only when the file doesn't parse at all, not merely when it's
      // newer than this build.
      await adapter
        .rename(MANIFEST_FILE, `${MANIFEST_FILE}.corrupt-${Date.now()}`)
        .catch(() => {})
    }
  }
  const manifest = createManifest(path.basename(adapter.root))
  await writeManifest(adapter, manifest)
  return { manifest, readOnly: false }
}

export function createManifest(name: string): ProjectManifest {
  const now = new Date().toISOString()
  return projectManifestSchema.parse({
    formatVersion: FORMAT_VERSIONS.manifest,
    id: ulid(),
    name,
    created: now,
    modified: now,
    settings: {},
    styles: BUILTIN_STYLES
  })
}

async function writeManifest(adapter: VfsAdapter, manifest: ProjectManifest): Promise<void> {
  await adapter.mkdir(PUB_DIR)
  await adapter.writeFileAtomic(MANIFEST_FILE, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'))
}
