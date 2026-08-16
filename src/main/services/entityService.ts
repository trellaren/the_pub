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
import { ENTITIES_FILE, FORMAT_VERSIONS } from '../../shared/constants.js'
import { JsonCollectionService } from './jsonCollectionService.js'

function emptyFile(): EntityFile {
  return { formatVersion: FORMAT_VERSIONS.entities, entities: [], dismissed: [] }
}

/**
 * Characters and locations, persisted to `.thepub/entities.json`.
 *
 * Unlike the other collection services this one keeps a second array,
 * `dismissed`, alongside its items — outside what `JsonCollectionService`
 * models, since dismissals aren't records themselves. It's cheap to reach
 * `this.cache` directly for that, the same way `BeatService` reaches it for
 * `columns` and `MapService` never needs to at all.
 */
export class EntityService extends JsonCollectionService<StoryEntity, EntityFile> {
  constructor(adapter: VfsAdapter) {
    super(adapter, {
      file: ENTITIES_FILE,
      kind: 'entities',
      schema: entityFileSchema,
      empty: emptyFile,
      items: (file) => file.entities,
      withItems: (file, entities) => ({ ...file, entities }),
      idOf: (entity) => entity.id
    })
  }

  async create(kind: EntityKind, name: string): Promise<StoryEntity> {
    const now = new Date().toISOString()
    const entity = storyEntitySchema.parse({
      id: ulid(),
      kind,
      name,
      // A project should be legible before anyone opens a colour picker.
      color: colorForIndex(this.items().length),
      created: now,
      modified: now
    })
    this.upsert(entity)
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
    this.upsert(entity)
    await this.flush()
    return structuredClone(entity)
  }

  async remove(id: string): Promise<void> {
    this.deleteById(id)
    // Dismissals name a record that no longer exists; leaving them would
    // silently suppress a future record that happened to reuse the id.
    this.cache = { ...this.cache, dismissed: this.cache.dismissed.filter((item) => item.entityId !== id) }
    await this.flush()
  }

  async dismiss(entityId: string, docId: string, surface: string): Promise<void> {
    const already = this.cache.dismissed.some(
      (item) => item.entityId === entityId && item.docId === docId && item.surface === surface
    )
    if (already) return
    this.cache = { ...this.cache, dismissed: [...this.cache.dismissed, { entityId, docId, surface }] }
    await this.flush()
  }
}
