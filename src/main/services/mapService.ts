import { ulid } from 'ulid'
import type { VfsAdapter } from '../vfs/types.js'
import {
  mapFileSchema,
  storyMapSchema,
  wouldCycle,
  type MapFile,
  type StoryMap
} from '../../shared/model/map.js'
import { FORMAT_VERSIONS, MAPS_FILE } from '../../shared/constants.js'
import { JsonCollectionService } from './jsonCollectionService.js'

function emptyFile(): MapFile {
  return { formatVersion: FORMAT_VERSIONS.maps, maps: [] }
}

/**
 * Maps, persisted to `.thepub/maps.json`.
 *
 * Shapes are vectors, so even a heavily drawn project is a few hundred
 * kilobytes — small enough that one file and no partial loading stays honest.
 */
export class MapService extends JsonCollectionService<StoryMap, MapFile> {
  constructor(adapter: VfsAdapter) {
    super(adapter, {
      file: MAPS_FILE,
      kind: 'maps',
      schema: mapFileSchema,
      empty: emptyFile,
      items: (file) => file.maps,
      withItems: (file, maps) => ({ ...file, maps }),
      idOf: (map) => map.id
    })
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
    this.upsert(map)
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
        shape.childMapId && wouldCycle(this.items(), incoming.id, shape.childMapId)
          ? { ...shape, childMapId: null }
          : shape
      ),
      created: existing?.created ?? incoming.created,
      modified: new Date().toISOString()
    })
    this.upsert(map)
    await this.flush()
    return structuredClone(map)
  }

  async remove(id: string): Promise<void> {
    this.setItems(
      this.items()
        .filter((map) => map.id !== id)
        // Shapes pointing at the deleted map become ordinary shapes rather than
        // dead links the UI has to keep testing for.
        .map((map) => ({
          ...map,
          shapes: map.shapes.map((shape) => (shape.childMapId === id ? { ...shape, childMapId: null } : shape))
        }))
    )
    await this.flush()
  }
}
