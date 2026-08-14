import type { DocumentService } from './documentService.js'
import type { SearchIndexService } from './searchIndexService.js'
import type { EntityService } from './entityService.js'
import { applyMentionMark } from '../../shared/pm/applyMention.js'
import type { MentionRef } from '../../shared/model/mention.js'

export type ConfirmResult =
  | { ok: true; mtime: number }
  | { ok: false; reason: 'missing-document' | 'missing-entity' | 'not-found' | 'conflict' }

/**
 * Promoting a name-scan suggestion into a real mention mark.
 *
 * This lives in the main process because the target document is usually *not
 * open* — that is the entire point of a backlink list — and because "confirm
 * all forty" must not open forty editor tabs to do its work.
 *
 * When the document *is* open the renderer takes the in-editor path instead:
 * routing an open document through here would force a reload, and reloading
 * calls `setContent`, which discards that document's undo history. A one-click
 * action must not silently destroy undo.
 */
export class MentionService {
  constructor(
    private readonly documents: DocumentService,
    private readonly search: SearchIndexService,
    private readonly entities: EntityService
  ) {}

  async confirm(ref: MentionRef): Promise<ConfirmResult> {
    const entity = this.entities.get(ref.entityId)
    if (!entity) return { ok: false, reason: 'missing-entity' }

    const docPath = this.search.resolvePath(ref.docId)
    if (!docPath) return { ok: false, reason: 'missing-document' }

    let loaded
    try {
      loaded = await this.documents.read(docPath)
    } catch {
      return { ok: false, reason: 'missing-document' }
    }

    const content = applyMentionMark(loaded.doc.content, ref.blockIndex, ref.surface, ref.ordinal, {
      entityId: entity.id,
      entityKind: entity.kind
    })
    // The prose moved on since the suggestion was indexed: ordinary, not an error.
    if (!content) return { ok: false, reason: 'not-found' }

    // Pass the mtime we just read, so the existing conflict check does real work
    // against anything that changed the file in between.
    const written = await this.documents.write(docPath, { ...loaded.doc, content }, loaded.mtime)
    if (!written.ok) return { ok: false, reason: 'conflict' }

    await this.search.indexDocument(docPath, written.mtime)
    return { ok: true, mtime: written.mtime }
  }

  /**
   * Confirm every outstanding suggestion for one record.
   *
   * One read-modify-write per suggestion, and the refs collected up front stay
   * valid throughout: confirming adds a mark but changes no text, so the block
   * text and therefore every ordinal in it are exactly what they were.
   */
  async confirmAll(entityId: string): Promise<{ confirmed: number; failed: number }> {
    const hits = this.search.mentionsForEntity({ entityId, confirmed: false, limit: 1000 })
    let confirmed = 0
    let failed = 0
    for (const hit of hits) {
      const result = await this.confirm({
        entityId,
        docId: hit.docId,
        blockIndex: hit.blockIndex,
        ordinal: hit.ordinal,
        surface: hit.surface
      })
      if (result.ok) confirmed += 1
      else failed += 1
    }
    return { confirmed, failed }
  }

  /** Silence one suggestion for good, then drop it from the index. */
  async dismiss(entityId: string, docId: string, surface: string): Promise<void> {
    await this.entities.dismiss(entityId, docId, surface)
    this.search.invalidateRoster()
    this.search.rescanSuggestions()
  }
}
