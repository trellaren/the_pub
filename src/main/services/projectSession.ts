import path from 'node:path'
import { createHash } from 'node:crypto'
import { app } from 'electron'
import { ulid } from 'ulid'
import type { VfsAdapter, Unwatch } from '../vfs/types.js'
import { createAdapter, parseUri } from '../vfs/vfsRegistry.js'
import { projectManifestSchema, type ProjectManifest, type OpenProject } from '../../shared/model/manifest.js'
import { BUILTIN_STYLES } from '../../shared/model/style.js'
import type { FileChangeEvent } from '../../shared/model/vfs.js'
import type { IndexProgress } from '../../shared/model/search.js'
import { DocumentService } from './documentService.js'
import { SnapshotService } from './snapshotService.js'
import { SearchIndexService } from './searchIndexService.js'
import { LayoutService } from './layoutService.js'
import { EntityService } from './entityService.js'
import { BeatService } from './beatService.js'
import { MentionService } from './mentionService.js'
import { MANIFEST_FILE, PUB_DIR, ASSETS_DIR, DOC_EXT, FORMAT_VERSION } from '../../shared/constants.js'

export interface SessionHooks {
  onFileChange: (events: FileChangeEvent[]) => void
  onIndexProgress: (progress: IndexProgress) => void
}

/**
 * Everything that makes up one open project: its backend, its manifest, and the
 * services scoped to it. A window owns exactly one session; popout windows share
 * their opener's.
 */
export class ProjectSession {
  readonly documents: DocumentService
  readonly snapshots: SnapshotService
  readonly search: SearchIndexService
  readonly layout: LayoutService
  readonly entities: EntityService
  readonly beats: BeatService
  readonly mentions: MentionService
  private unwatch: Unwatch | null = null

  private constructor(
    readonly uri: string,
    readonly adapter: VfsAdapter,
    public manifest: ProjectManifest,
    private readonly hooks: SessionHooks
  ) {
    this.snapshots = new SnapshotService(adapter)
    this.documents = new DocumentService(adapter, this.snapshots)
    this.layout = new LayoutService(adapter)
    this.entities = new EntityService(adapter)
    this.beats = new BeatService(adapter)
    this.search = new SearchIndexService(
      adapter,
      indexDbPath(uri, adapter.root),
      hooks.onIndexProgress,
      // A lambda, constructed before the service that reads it: the indexer
      // pulls the roster when it needs it rather than being handed one, so
      // there is no window in which it runs against an empty set.
      () => this.entities.snapshot()
    )
    this.mentions = new MentionService(this.documents, this.search, this.entities)
  }

  static async open(uri: string, hooks: SessionHooks): Promise<ProjectSession> {
    const adapter = createAdapter(uri)
    const manifest = await loadOrCreateManifest(adapter)
    const session = new ProjectSession(uri, adapter, manifest, hooks)
    await session.start()
    return session
  }

  private async start(): Promise<void> {
    await this.adapter.mkdir(ASSETS_DIR).catch(() => {})
    // Before the first index pass, so documents are scanned against the real
    // roster rather than an empty one.
    await this.entities.load().catch(() => {})
    await this.beats.load().catch(() => {})
    this.unwatch = await this.adapter.watch('', (events) => void this.handleFileChanges(events))
    // Index in the background: a large project must not delay the first paint.
    void this.search.syncAll().catch(() => {})
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
    return { uri: this.uri, root: this.adapter.root, manifest: this.manifest }
  }

  async saveManifest(manifest: ProjectManifest): Promise<ProjectManifest> {
    const next: ProjectManifest = { ...manifest, modified: new Date().toISOString() }
    await writeManifest(this.adapter, next)
    this.manifest = next
    return next
  }

  async close(): Promise<void> {
    if (this.unwatch) await this.unwatch()
    this.unwatch = null
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

async function loadOrCreateManifest(adapter: VfsAdapter): Promise<ProjectManifest> {
  const existing = await adapter.stat(MANIFEST_FILE)
  if (existing) {
    try {
      const raw = await adapter.readFile(MANIFEST_FILE)
      return projectManifestSchema.parse(JSON.parse(raw.toString('utf8')))
    } catch {
      // Keep the unreadable manifest rather than deleting it — it may hold
      // styles the author wants back — and continue with a fresh one.
      await adapter
        .rename(MANIFEST_FILE, `${MANIFEST_FILE}.corrupt-${Date.now()}`)
        .catch(() => {})
    }
  }
  const manifest = createManifest(path.basename(adapter.root))
  await writeManifest(adapter, manifest)
  return manifest
}

export function createManifest(name: string): ProjectManifest {
  const now = new Date().toISOString()
  return projectManifestSchema.parse({
    formatVersion: FORMAT_VERSION,
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
