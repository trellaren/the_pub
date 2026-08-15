import { ulid } from 'ulid'
import type { VfsAdapter } from '../vfs/types.js'
import {
  mapFileSchema,
  storyMapSchema,
  wouldCycle,
  type MapFile,
  type StoryMap
} from '../../shared/model/map.js'
import { MAPS_FILE, PUB_DIR, FORMAT_VERSION } from '../../shared/constants.js'

function emptyFile(): MapFile {
  return { formatVersion: FORMAT_VERSION, maps: [] }
}

/**
 * Maps, persisted to `.thepub/maps.json`.
 *
 * Third file-backed service in the same shape as EntityService and BeatService:
 * sole writer, in-memory cache, corrupt file set aside rather than overwritten.
 * Shapes are vectors, so even a heavily drawn project is a few hundred
 * kilobytes — small enough that one file and no partial loading stays honest.
 */
export class MapService {
  private cache: MapFile = emptyFile()
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly adapter: VfsAdapter) {}

  async load(): Promise<MapFile> {
    const existing = await this.adapter.stat(MAPS_FILE)
    if (!existing) {
      this.cache = emptyFile()
      return this.snapshot()
    }
    try {
      const raw = await this.adapter.readFile(MAPS_FILE)
      this.cache = mapFileSchema.parse(JSON.parse(raw.toString('utf8')))
    } catch {
      await this.adapter.rename(MAPS_FILE, `${MAPS_FILE}.corrupt-${Date.now()}`).catch(() => {})
      this.cache = emptyFile()
    }
    return this.snapshot()
  }

  snapshot(): MapFile {
    return structuredClone(this.cache)
  }

  get(id: string): StoryMap | null {
    return this.cache.maps.find((map) => map.id === id) ?? null
  }

  async create(input: {
    name: string
    background?: string | null
    width?: number
    height?: number
  }): Promise<StoryMap> {
    const now = new Date().toISOString()
    const map = storyMapSchema.parse({
      id: ulid(),
      name: input.name,
      background: input.background ?? null,
      // Omitted sizes fall to the schema's defaults, so a sketched map keeps
      // the box every hand-drawn map has always had.
      ...(input.width ? { width: input.width } : {}),
      ...(input.height ? { height: input.height } : {}),
      created: now,
      modified: now
    })
    this.cache.maps = [...this.cache.maps, map]
    await this.flush()
    return structuredClone(map)
  }

  async save(incoming: StoryMap): Promise<StoryMap> {
    const existing = this.get(incoming.id)
    const map = storyMapSchema.parse({
      ...incoming,
      // A drill-down link that closes a loop would make the breadcrumb walk
      // meaningless, so it is dropped here rather than trusted and guarded at
      // every read.
      shapes: incoming.shapes.map((shape) =>
        shape.childMapId && wouldCycle(this.cache.maps, incoming.id, shape.childMapId)
          ? { ...shape, childMapId: null }
          : shape
      ),
      created: existing?.created ?? incoming.created,
      modified: new Date().toISOString()
    })
    this.cache.maps = existing
      ? this.cache.maps.map((candidate) => (candidate.id === map.id ? map : candidate))
      : [...this.cache.maps, map]
    await this.flush()
    return structuredClone(map)
  }

  async remove(id: string): Promise<void> {
    this.cache.maps = this.cache.maps
      .filter((map) => map.id !== id)
      // Shapes pointing at the deleted map become ordinary shapes rather than
      // dead links the UI has to keep testing for.
      .map((map) => ({
        ...map,
        shapes: map.shapes.map((shape) =>
          shape.childMapId === id ? { ...shape, childMapId: null } : shape
        )
      }))
    await this.flush()
  }

  private async flush(): Promise<void> {
    const file: MapFile = { ...this.cache, formatVersion: FORMAT_VERSION }
    this.queue = this.queue.then(async () => {
      await this.adapter.mkdir(PUB_DIR).catch(() => {})
      await this.adapter.writeFileAtomic(
        MAPS_FILE,
        Buffer.from(`${JSON.stringify(file, null, 2)}\n`, 'utf8')
      )
    })
    await this.queue
  }
}
