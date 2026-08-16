import type { ZodType } from 'zod'
import type { VfsAdapter } from '../vfs/types.js'
import { PUB_DIR, FORMAT_VERSIONS, type FileKind } from '../../shared/constants.js'

export interface JsonCollectionOptions<TItem, TFile> {
  /** Project-relative path, e.g. `.thepub/sources.json`. */
  file: string
  kind: FileKind
  schema: ZodType<TFile>
  empty: () => TFile
  items: (file: TFile) => TItem[]
  withItems: (file: TFile, items: TItem[]) => TFile
  idOf: (item: TItem) => string
}

/**
 * The load/save shape `EntityService`, `BeatService` and `MapService` had
 * already converged on independently, before `SourceService` became a fourth
 * clone and made the duplication worth naming: an in-memory cache with this
 * process as its sole writer, writes serialised through a queue so two quick
 * saves cannot land out of order, and a file that fails to parse set aside as
 * `.corrupt-<timestamp>` rather than overwritten — it may hold work the
 * author cannot retype.
 *
 * `create` and `save` are deliberately **not** here. Each subclass mints
 * different fields on the way in — an entity's colour, a beat's sort key
 * derived from its label, a map's drill-down cycle guard — and folding that
 * into one generic method would make the generic method the one place nobody
 * can read what a save actually does. What *is* shared below the point where
 * those diverge — replacing-or-appending an item by id, deleting one, writing
 * the file — is factored out as protected helpers a subclass composes.
 */
export abstract class JsonCollectionService<TItem, TFile extends { formatVersion: number }> {
  protected cache: TFile
  private queue: Promise<void> = Promise.resolve()

  constructor(
    protected readonly adapter: VfsAdapter,
    private readonly opts: JsonCollectionOptions<TItem, TFile>
  ) {
    this.cache = opts.empty()
  }

  async load(): Promise<TFile> {
    const existing = await this.adapter.stat(this.opts.file)
    if (!existing) {
      this.cache = this.opts.empty()
      return this.snapshot()
    }
    try {
      const raw = await this.adapter.readFile(this.opts.file)
      this.cache = this.opts.schema.parse(JSON.parse(raw.toString('utf8')))
    } catch {
      await this.adapter.rename(this.opts.file, `${this.opts.file}.corrupt-${Date.now()}`).catch(() => {})
      this.cache = this.opts.empty()
    }
    return this.snapshot()
  }

  /**
   * The current collection, synchronously and by value: callers — the
   * renderer store, the search indexer's roster lambda — mutate what they
   * receive.
   */
  snapshot(): TFile {
    return structuredClone(this.cache)
  }

  get(id: string): TItem | null {
    return this.opts.items(this.cache).find((item) => this.opts.idOf(item) === id) ?? null
  }

  protected items(): TItem[] {
    return this.opts.items(this.cache)
  }

  protected setItems(items: TItem[]): void {
    this.cache = this.opts.withItems(this.cache, items)
  }

  /** Replace the item sharing its id, or append if none does. */
  protected upsert(item: TItem): void {
    const id = this.opts.idOf(item)
    const items = this.items()
    const existingIndex = items.findIndex((candidate) => this.opts.idOf(candidate) === id)
    this.setItems(
      existingIndex === -1
        ? [...items, item]
        : items.map((candidate, index) => (index === existingIndex ? item : candidate))
    )
  }

  protected deleteById(id: string): void {
    this.setItems(this.items().filter((item) => this.opts.idOf(item) !== id))
  }

  protected async flush(): Promise<void> {
    const file = { ...this.cache, formatVersion: FORMAT_VERSIONS[this.opts.kind] } as TFile
    this.queue = this.queue.then(async () => {
      await this.adapter.mkdir(PUB_DIR).catch(() => {})
      await this.adapter.writeFileAtomic(
        this.opts.file,
        Buffer.from(`${JSON.stringify(file, null, 2)}\n`, 'utf8')
      )
    })
    await this.queue
  }
}
