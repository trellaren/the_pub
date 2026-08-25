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
    return this.add({ kind, name })
  }

  /**
   * Write a record the assistant drafted.
   *
   * A real record in the real file, flagged — not a preview in a sidecar. A
   * draft cast that lives outside the record store cannot be searched,
   * mentioned, reordered or linked to a beat, so the writer cannot *work* with
   * it, which is the only way to find out whether it is any good.
   */
  async draft(
    kind: EntityKind,
    name: string,
    patch: Partial<StoryEntity> = {}
  ): Promise<StoryEntity> {
    return this.add({ ...patch, kind, name, provisional: true })
  }

  private async add(patch: Partial<StoryEntity> & { kind: EntityKind; name: string }): Promise<StoryEntity> {
    const now = new Date().toISOString()
    const entity = storyEntitySchema.parse({
      // A project should be legible before anyone opens a colour picker.
      color: colorForIndex(this.items().length),
      ...patch,
      id: ulid(),
      created: now,
      modified: now
    })
    this.upsert(entity)
    await this.flush()
    return structuredClone(entity)
  }

  /**
   * Take a drafted record as the writer's own. Clearing the flag is all that
   * accepting does — and it is also what puts the record permanently out of
   * every assistant tool's reach.
   */
  async accept(id: string): Promise<StoryEntity> {
    const existing = this.get(id)
    if (!existing) throw new Error('That record no longer exists.')
    return this.save({ ...existing, provisional: false })
  }

  /**
   * Throw away a draft nobody accepted.
   *
   * Refuses an accepted record rather than deleting it. Discard is the button
   * beside Accept on a provisional card, and a stray call reaching an accepted
   * record would be deleting the writer's own work with a name that sounds
   * like it could not.
   */
  async discard(id: string): Promise<void> {
    const existing = this.get(id)
    if (!existing) return
    if (!existing.provisional) {
      throw new Error(`${existing.name} has been accepted, so it can only be deleted deliberately.`)
    }
    await this.remove(id)
  }

  /**
   * Apply an assistant's proposed changes to a record it drafted.
   *
   * The refusal is the point, and it is enforced here rather than asked of the
   * model: a tool may only change a record nobody has accepted. The failure
   * this prevents is a model tidying a character the writer spent an afternoon
   * on, and no amount of prompting is a substitute for the service saying no.
   */
  async revise(id: string, changes: Partial<StoryEntity>): Promise<StoryEntity> {
    const existing = this.get(id)
    if (!existing) throw new Error('That record no longer exists.')
    if (!existing.provisional) {
      throw new Error(
        `${existing.name} has been accepted, so the assistant cannot change it. Ask the writer instead.`
      )
    }
    // `id`, `kind` and `provisional` are not the assistant's to move: a revision
    // that could clear the flag would be an accept, which is a person's act.
    const { id: _id, kind: _kind, provisional: _provisional, ...allowed } = changes
    return this.save({ ...existing, ...allowed })
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
