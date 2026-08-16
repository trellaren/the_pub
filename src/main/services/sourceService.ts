import { ulid } from 'ulid'
import type { VfsAdapter } from '../vfs/types.js'
import {
  sourceFileSchema,
  cslItemSchema,
  EMPTY_SOURCE_FILE,
  type SourceFile,
  type CslItem
} from '../../shared/model/source.js'
import { SOURCES_FILE } from '../../shared/constants.js'
import { JsonCollectionService } from './jsonCollectionService.js'

/**
 * A project's citable sources, persisted to `.thepub/sources.json` as
 * CSL-JSON. The fourth near-clone of the load/save shape `EntityService`,
 * `BeatService` and `MapService` already had, and the one that made
 * extracting `JsonCollectionService` worth doing.
 */
export class SourceService extends JsonCollectionService<CslItem, SourceFile> {
  constructor(adapter: VfsAdapter) {
    super(adapter, {
      file: SOURCES_FILE,
      kind: 'sources',
      schema: sourceFileSchema,
      empty: () => EMPTY_SOURCE_FILE,
      items: (file) => file.sources,
      withItems: (file, sources) => ({ ...file, sources }),
      idOf: (item) => item.id
    })
  }

  async create(type: string): Promise<CslItem> {
    const item = cslItemSchema.parse({ id: ulid(), type, title: '' })
    this.upsert(item)
    await this.flush()
    return structuredClone(item)
  }

  async save(incoming: CslItem): Promise<CslItem> {
    const item = cslItemSchema.parse(incoming)
    this.upsert(item)
    await this.flush()
    return structuredClone(item)
  }

  async remove(id: string): Promise<void> {
    this.deleteById(id)
    await this.flush()
  }
}

// BibTeX/RIS import and DOI/ISBN lookup are deliberately not here yet — see
// docs/phase-5-plan.md Part 5. Both would land as a `merge(items: CslItem[])`
// that upserts by id, the same way `save` does for a hand-edited source; there
// is no caller for that yet, so it isn't written until there is one.
