import { ulid } from 'ulid'
import type { VfsAdapter } from '../vfs/types.js'
import {
  pdfHighlightFileSchema,
  pdfHighlightSchema,
  type PdfHighlight,
  type PdfHighlightFile
} from '../../shared/model/research.js'
import { migrate } from '../../shared/model/migrate.js'
import { RESEARCH_DIR, FORMAT_VERSIONS } from '../../shared/constants.js'
import { resolvePdfHighlight, type PdfAnchorCandidate } from '../research/pdfAnchor.js'

/**
 * Highlights made inside a research attachment, one file per attachment:
 * `.thepub/research/<sourceId>/<attachmentId>.highlights.json`. Mirrors
 * `HighlightService`'s shape for the same single-writer-per-file reasoning.
 */
export class PdfHighlightService {
  private cache = new Map<string, PdfHighlightFile>()

  constructor(private readonly adapter: VfsAdapter) {}

  private key(sourceId: string, attachmentId: string): string {
    return `${sourceId}/${attachmentId}`
  }

  private pathFor(sourceId: string, attachmentId: string): string {
    return `${RESEARCH_DIR}/${sourceId}/${attachmentId}.highlights.json`
  }

  private async loadFile(sourceId: string, attachmentId: string): Promise<PdfHighlightFile> {
    const key = this.key(sourceId, attachmentId)
    const cached = this.cache.get(key)
    if (cached) return cached

    const path = this.pathFor(sourceId, attachmentId)
    const existing = await this.adapter.stat(path)
    if (!existing) {
      const empty: PdfHighlightFile = { formatVersion: FORMAT_VERSIONS.pdfHighlights, highlights: [] }
      this.cache.set(key, empty)
      return empty
    }
    try {
      const raw = await this.adapter.readFile(path)
      const { value } = migrate('pdfHighlights', JSON.parse(raw.toString('utf8')))
      const file = pdfHighlightFileSchema.parse(value)
      this.cache.set(key, file)
      return file
    } catch {
      await this.adapter.rename(path, `${path}.corrupt-${Date.now()}`).catch(() => {})
      const empty: PdfHighlightFile = { formatVersion: FORMAT_VERSIONS.pdfHighlights, highlights: [] }
      this.cache.set(key, empty)
      return empty
    }
  }

  private async flush(sourceId: string, attachmentId: string): Promise<void> {
    const key = this.key(sourceId, attachmentId)
    const file = this.cache.get(key)
    if (!file) return
    const dir = `${RESEARCH_DIR}/${sourceId}`
    await this.adapter.mkdir(dir).catch(() => {})
    await this.adapter.writeFileAtomic(
      this.pathFor(sourceId, attachmentId),
      Buffer.from(`${JSON.stringify(file, null, 2)}\n`, 'utf8')
    )
  }

  async listForAttachment(sourceId: string, attachmentId: string): Promise<PdfHighlight[]> {
    const file = await this.loadFile(sourceId, attachmentId)
    return structuredClone(file.highlights)
  }

  async save(
    sourceId: string,
    attachmentId: string,
    fields: {
      id?: string
      color: string
      categoryId?: string
      note?: string
      authorId?: string
      quote: string
      page: number
      rects?: [number, number, number, number][]
    }
  ): Promise<PdfHighlight> {
    const file = await this.loadFile(sourceId, attachmentId)
    const now = new Date().toISOString()
    const existing = fields.id ? file.highlights.find((candidate) => candidate.id === fields.id) : undefined
    const highlight = pdfHighlightSchema.parse({
      id: existing?.id ?? fields.id ?? ulid(),
      sourceId,
      attachmentId,
      color: fields.color,
      categoryId: fields.categoryId ?? existing?.categoryId ?? '',
      note: fields.note ?? existing?.note ?? '',
      authorId: fields.authorId ?? existing?.authorId ?? '',
      quote: fields.quote,
      page: fields.page,
      rects: fields.rects ?? existing?.rects ?? [],
      orphaned: false,
      created: existing?.created ?? now,
      modified: now
    })
    file.highlights = existing
      ? file.highlights.map((candidate) => (candidate.id === highlight.id ? highlight : candidate))
      : [...file.highlights, highlight]
    await this.flush(sourceId, attachmentId)
    return structuredClone(highlight)
  }

  async remove(sourceId: string, attachmentId: string, id: string): Promise<void> {
    const file = await this.loadFile(sourceId, attachmentId)
    file.highlights = file.highlights.filter((highlight) => highlight.id !== id)
    await this.flush(sourceId, attachmentId)
  }

  /**
   * Re-resolve every highlight in an attachment against the page text pdf.js
   * currently extracts from it — quote first, stored page second, per
   * `pdfAnchor.ts`. Never deletes; a highlight `resolvePdfHighlight` cannot
   * place anywhere is flagged orphaned, exactly as `HighlightService.reconcile` does.
   */
  async reconcile(sourceId: string, attachmentId: string, candidates: PdfAnchorCandidate[]): Promise<PdfHighlight[] | null> {
    const file = await this.loadFile(sourceId, attachmentId)
    if (file.highlights.length === 0) return null

    let changed = false
    file.highlights = file.highlights.map((highlight) => {
      const resolved = resolvePdfHighlight(highlight, candidates)
      if (!resolved) {
        if (highlight.orphaned) return highlight
        changed = true
        return { ...highlight, orphaned: true }
      }
      if (!highlight.orphaned && resolved.page === highlight.page) return highlight
      changed = true
      return { ...highlight, orphaned: false, page: resolved.page }
    })
    if (!changed) return null
    await this.flush(sourceId, attachmentId)
    return structuredClone(file.highlights)
  }
}
