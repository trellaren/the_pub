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

  /**
   * Add imported or looked-up sources to the library.
   *
   * Importing the same file twice, or looking a DOI up after already having
   * it, must not double the library — both are ordinary things to do. An
   * incoming id that is already present replaces the stored source rather than
   * being skipped, so re-importing a corrected `.bib` is how you fix a typo
   * without hunting for the entry by hand.
   *
   * A source that arrives without an id, or with one this build cannot parse,
   * is counted as skipped rather than failing the whole import: one bad record
   * in a library of four hundred must not cost the other three hundred and
   * ninety-nine.
   */
  async merge(incoming: CslItem[]): Promise<{ added: number; replaced: number; skipped: number }> {
    await this.load()
    let added = 0
    let replaced = 0
    let skipped = 0

    for (const candidate of incoming) {
      const parsed = cslItemSchema.safeParse(candidate)
      if (!parsed.success || !parsed.data.id) {
        skipped++
        continue
      }
      if (this.get(parsed.data.id)) replaced++
      else added++
      this.upsert(parsed.data)
    }

    if (added > 0 || replaced > 0) await this.flush()
    return { added, replaced, skipped }
  }
}
