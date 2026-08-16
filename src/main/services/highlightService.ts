import type { VfsAdapter } from '../vfs/types.js'
import {
  highlightFileSchema,
  highlightSchema,
  type Highlight,
  type HighlightFile
} from '../../shared/model/highlight.js'
import { migrate } from '../../shared/model/migrate.js'
import { findAnchor, type AnchorMarkConfig } from '../../shared/pm/anchors.js'
import type { PmDoc } from '../../shared/model/document.js'
import { HIGHLIGHTS_DIR, FORMAT_VERSIONS } from '../../shared/constants.js'

/** The `highlight` mark's own attribute, reusing `findAnchor`'s generic walker. See `anchors.ts`. */
const HIGHLIGHT_MARK_CONFIG: AnchorMarkConfig = { markType: 'highlight', attrKey: 'highlightId' }

/**
 * Collected highlights, one file per document — `noteService`'s shape,
 * for `noteService`'s reasons. See `docs/phase-11-plan.md`.
 */
export class HighlightService {
  private cache = new Map<string, HighlightFile>()

  constructor(private readonly adapter: VfsAdapter) {}

  private pathFor(docId: string): string {
    return `${HIGHLIGHTS_DIR}/${docId}.json`
  }

  private async loadFile(docId: string): Promise<HighlightFile> {
    const cached = this.cache.get(docId)
    if (cached) return cached

    const path = this.pathFor(docId)
    const existing = await this.adapter.stat(path)
    if (!existing) {
      const empty: HighlightFile = { formatVersion: FORMAT_VERSIONS.highlights, highlights: [] }
      this.cache.set(docId, empty)
      return empty
    }
    try {
      const raw = await this.adapter.readFile(path)
      const { value } = migrate('highlights', JSON.parse(raw.toString('utf8')))
      const file = highlightFileSchema.parse(value)
      this.cache.set(docId, file)
      return file
    } catch {
      // Keep the unreadable file rather than deleting it — see `NoteService.loadFile`.
      await this.adapter.rename(path, `${path}.corrupt-${Date.now()}`).catch(() => {})
      const empty: HighlightFile = { formatVersion: FORMAT_VERSIONS.highlights, highlights: [] }
      this.cache.set(docId, empty)
      return empty
    }
  }

  private async flush(docId: string): Promise<void> {
    const file = this.cache.get(docId)
    if (!file) return
    await this.adapter.mkdir(HIGHLIGHTS_DIR).catch(() => {})
    await this.adapter.writeFileAtomic(
      this.pathFor(docId),
      Buffer.from(`${JSON.stringify(file, null, 2)}\n`, 'utf8')
    )
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
