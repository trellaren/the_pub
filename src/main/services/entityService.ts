import { ulid } from 'ulid'
import type { VfsAdapter } from '../vfs/types.js'
import {
  entityFileSchema,
  storyEntitySchema,
  colorForIndex,
  type EntityFile,
  type EntityKind,
  type StoryEntity
} from '../../shared/model/entity.js'
import { ENTITIES_FILE, PUB_DIR, FORMAT_VERSIONS } from '../../shared/constants.js'

/**
 * Characters and locations, persisted to `.thepub/entities.json`.
 *
 * Unlike the other file-backed services this one keeps an **in-memory cache**,
 * because the indexer needs the roster synchronously inside a SQLite
 * transaction and cannot await a file read there.
 *
 * That cache also makes this the *only* writer of the file, and it never
 * re-reads on a watcher event. Together with `.thepub` being excluded from the
 * watcher, a write → watch → reload → write loop becomes structurally
 * impossible rather than merely unlikely. The cost is that hand-editing
 * entities.json while the app is open will not hot-reload, which is the right
 * trade for a file the app rewrites on every keystroke-debounce.
 */
export class EntityService {
  private cache: EntityFile = { formatVersion: FORMAT_VERSIONS.entities, entities: [], dismissed: [] }
  /** Serialises writes, so two quick saves cannot land out of order. */
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly adapter: VfsAdapter) {}

  async load(): Promise<EntityFile> {
    const existing = await this.adapter.stat(ENTITIES_FILE)
    if (!existing) {
      this.cache = { formatVersion: FORMAT_VERSIONS.entities, entities: [], dismissed: [] }
      return this.snapshot()
    }
    try {
      const raw = await this.adapter.readFile(ENTITIES_FILE)
      this.cache = entityFileSchema.parse(JSON.parse(raw.toString('utf8')))
    } catch {
      // Keep the unreadable file rather than overwriting it — it holds work the
      // author cannot retype — and carry on with an empty roster.
      await this.adapter
        .rename(ENTITIES_FILE, `${ENTITIES_FILE}.corrupt-${Date.now()}`)
        .catch(() => {})
      this.cache = { formatVersion: FORMAT_VERSIONS.entities, entities: [], dismissed: [] }
    }
    return this.snapshot()
  }

  /**
   * The current roster, synchronously. Returned by value: the renderer and the
   * indexer both mutate what they receive.
   */
  snapshot(): EntityFile {
    return structuredClone(this.cache)
  }

  get(id: string): StoryEntity | null {
    return this.cache.entities.find((entity) => entity.id === id) ?? null
  }

  async create(kind: EntityKind, name: string): Promise<StoryEntity> {
    const now = new Date().toISOString()
    const entity = storyEntitySchema.parse({
      id: ulid(),
      kind,
      name,
      // A project should be legible before anyone opens a colour picker.
      color: colorForIndex(this.cache.entities.length),
      created: now,
      modified: now
    })
    this.cache.entities = [...this.cache.entities, entity]
    await this.flush()
    return structuredClone(entity)
  }

  async save(incoming: StoryEntity): Promise<StoryEntity> {
    const existing = this.get(incoming.id)
    const entity = storyEntitySchema.parse({
      ...incoming,
      created: existing?.created ?? incoming.created,
      modified: new Date().toISOString()
    })
    this.cache.entities = existing
      ? this.cache.entities.map((candidate) => (candidate.id === entity.id ? entity : candidate))
      : [...this.cache.entities, entity]
    await this.flush()
    return structuredClone(entity)
  }

  async remove(id: string): Promise<void> {
    this.cache.entities = this.cache.entities.filter((entity) => entity.id !== id)
    // Dismissals name a record that no longer exists; leaving them would
    // silently suppress a future record that happened to reuse the id.
    this.cache.dismissed = this.cache.dismissed.filter((item) => item.entityId !== id)
    await this.flush()
  }

  async dismiss(entityId: string, docId: string, surface: string): Promise<void> {
    const already = this.cache.dismissed.some(
      (item) => item.entityId === entityId && item.docId === docId && item.surface === surface
    )
    if (already) return
    this.cache.dismissed = [...this.cache.dismissed, { entityId, docId, surface }]
    await this.flush()
  }

  private async flush(): Promise<void> {
    const file: EntityFile = { ...this.cache, formatVersion: FORMAT_VERSIONS.entities }
    this.queue = this.queue.then(async () => {
      await this.adapter.mkdir(PUB_DIR).catch(() => {})
      await this.adapter.writeFileAtomic(
        ENTITIES_FILE,
        Buffer.from(`${JSON.stringify(file, null, 2)}\n`, 'utf8')
      )
    })
    await this.queue
  }
}
