import type { VfsAdapter } from '../vfs/types.js'
import {
  highlightFileSchema,
  highlightSchema,
  type Highlight,
  type HighlightFile,
  EMPTY_HIGHLIGHT_FILE
} from '../../shared/model/highlight.js'
import { readVersionedJson, KeyedSerialQueue, jsonBytes } from './versionedJson.js'
import { TooNewError } from './jsonCollectionService.js'
import { findAnchor, type AnchorMarkConfig } from '../../shared/pm/anchors.js'
import type { PmDoc } from '../../shared/model/document.js'
import { HIGHLIGHTS_DIR } from '../../shared/constants.js'

/** The `highlight` mark's own attribute, reusing `findAnchor`'s generic walker. See `anchors.ts`. */
const HIGHLIGHT_MARK_CONFIG: AnchorMarkConfig = { markType: 'highlight', attrKey: 'highlightId' }

/**
 * Collected highlights, one file per document — `noteService`'s shape,
 * for `noteService`'s reasons. See `docs/phase-11-plan.md`.
 */
export class HighlightService {
  private cache = new Map<string, HighlightFile>()
  /** Files a newer build wrote: shown as far as they parse, never written back. */
  private tooNew = new Set<string>()
  private readonly writes = new KeyedSerialQueue()

  constructor(private readonly adapter: VfsAdapter) {}

  private pathFor(docId: string): string {
    return `${HIGHLIGHTS_DIR}/${docId}.json`
  }

  private async loadFile(docId: string): Promise<HighlightFile> {
    const key = docId
    const cached = this.cache.get(key)
    if (cached) return cached
    const read = await readVersionedJson(this.adapter, this.pathFor(docId), 'highlights', highlightFileSchema, () => structuredClone(EMPTY_HIGHLIGHT_FILE))
    if (read.tooNew) this.tooNew.add(key)
    else this.tooNew.delete(key)
    this.cache.set(key, read.value)
    return read.value
  }

  private async flush(docId: string): Promise<void> {
    const key = docId
    if (this.tooNew.has(key)) throw new TooNewError(this.pathFor(docId))
    const file = this.cache.get(key)
    if (!file) return
    const bytes = jsonBytes(file)
    await this.writes.run(key, async () => {
      await this.adapter.mkdir(HIGHLIGHTS_DIR).catch(() => {})
      await this.adapter.writeFileAtomic(this.pathFor(docId), bytes)
    })
  }


  async listForDoc(docId: string): Promise<Highlight[]> {
    const file = await this.loadFile(docId)
    return structuredClone(file.highlights)
  }

  /**
   * Record metadata for a `highlightId` the renderer has already stamped
   * onto the mark (see `Highlight` extension's `collect` behaviour — the id
   * is allocated there, at the moment of collecting, never on a plain colour
   * toggle). Idempotent: collecting the same id twice updates in place.
   */
  async collect(
    docId: string,
    highlightId: string,
    fields: { color: string; quote: string; blockIndex: number; categoryId?: string; authorId?: string }
  ): Promise<Highlight> {
    const file = await this.loadFile(docId)
    const now = new Date().toISOString()
    const existing = file.highlights.find((candidate) => candidate.highlightId === highlightId)
    const highlight = highlightSchema.parse({
      id: existing?.id ?? highlightId,
      docId,
      highlightId,
      color: fields.color,
      categoryId: fields.categoryId ?? existing?.categoryId ?? '',
      note: existing?.note ?? '',
      authorId: fields.authorId ?? existing?.authorId ?? '',
      quote: fields.quote,
      blockIndex: fields.blockIndex,
      orphaned: false,
      created: existing?.created ?? now,
      modified: now
    })
    file.highlights = existing
      ? file.highlights.map((candidate) => (candidate.highlightId === highlightId ? highlight : candidate))
      : [...file.highlights, highlight]
    await this.flush(docId)
    return structuredClone(highlight)
  }

  async save(docId: string, incoming: Highlight): Promise<Highlight> {
    const file = await this.loadFile(docId)
    const existing = file.highlights.find((candidate) => candidate.id === incoming.id)
    const highlight = highlightSchema.parse({
      ...incoming,
      docId,
      created: existing?.created ?? incoming.created,
      modified: new Date().toISOString()
    })
    file.highlights = existing
      ? file.highlights.map((candidate) => (candidate.id === highlight.id ? highlight : candidate))
      : [...file.highlights, highlight]
    await this.flush(docId)
    return structuredClone(highlight)
  }

  async remove(docId: string, id: string): Promise<void> {
    const file = await this.loadFile(docId)
    file.highlights = file.highlights.filter((highlight) => highlight.id !== id)
    await this.flush(docId)
  }

  /**
   * Re-check every collected highlight's `highlightId` against the document
   * as just written. Same shape and same reasoning as `NoteService.reconcile`
   * — called after every save of the document, never deletes, only flags.
   */
  async reconcile(docId: string, content: PmDoc): Promise<Highlight[] | null> {
    const file = await this.loadFile(docId)
    if (file.highlights.length === 0) return null

    let changed = false
    file.highlights = file.highlights.map((highlight) => {
      const location = findAnchor(content, highlight.highlightId, HIGHLIGHT_MARK_CONFIG)
      if (!location) {
        if (highlight.orphaned) return highlight
        changed = true
        return { ...highlight, orphaned: true }
      }
      if (!highlight.orphaned && location.text === highlight.quote && location.blockIndex === highlight.blockIndex) {
        return highlight
      }
      changed = true
      return { ...highlight, orphaned: false, quote: location.text, blockIndex: location.blockIndex }
    })
    if (!changed) return null
    await this.flush(docId)
    return structuredClone(file.highlights)
  }
}
