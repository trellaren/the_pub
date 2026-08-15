import type { DocumentService } from './documentService.js'
import type { SnapshotService } from './snapshotService.js'
import type { SearchIndexService } from './searchIndexService.js'
import type { LoadedDocument } from '../../shared/model/document.js'

export type RestoreResult =
  | { ok: true; path: string; mtime: number }
  | { ok: false; reason: 'conflict'; diskMtime: number }
  | { ok: false; reason: 'missing-document' }

/**
 * Putting an old version back.
 *
 * A separate service rather than a method on `SnapshotService`, for the reason
 * `MentionService` is separate too: it needs `DocumentService` to write the
 * result and `SearchIndexService` to re-index it, and `SnapshotService` is
 * built before both of them. Folding this in would invert that order.
 */
export class HistoryService {
  constructor(
    private readonly documents: DocumentService,
    private readonly snapshots: SnapshotService,
    private readonly search: SearchIndexService
  ) {}

  /**
   * Replace a document with one of its own earlier versions.
   *
   * The current content is archived first, unthrottled, so a restore is itself
   * undoable — an author who restores the wrong version, or simply changes
   * their mind, finds what they had a moment ago at the top of the list.
   *
   * The write goes through `DocumentService` like any other, so it inherits the
   * atomic write and the mtime guard: a document edited outside the app since
   * this panel last looked is refused rather than quietly overwritten.
   */
  async restoreInPlace(docId: string, timestamp: string): Promise<RestoreResult> {
    const path = this.search.resolvePath(docId)
    if (!path) return { ok: false, reason: 'missing-document' }

    let current: LoadedDocument
    try {
      current = await this.documents.read(path)
    } catch {
      return { ok: false, reason: 'missing-document' }
    }

    await this.snapshots.forceSnapshot(current.doc)
    const restored = await this.snapshots.read(docId, timestamp)
    // The document keeps its own identity and creation date; only the content
    // and title come back. Taking the snapshot's `docId` wholesale would be the
    // same thing here, but not for a restore into a new file, and one rule for
    // both is easier to be sure of.
    const written = await this.documents.write(
      path,
      { ...restored, docId: current.doc.docId, created: current.doc.created },
      current.mtime
    )
    if (!written.ok) return written

    await this.search.indexDocument(path, written.mtime).catch(() => {})
    return { ok: true, path, mtime: written.mtime }
  }

  /**
   * Write an old version out as a new document.
   *
   * The original and its history are left alone, so this is the safe way to
   * look at how a chapter used to read without giving up how it reads now.
   */
  async restoreToNewFile(docId: string, timestamp: string, targetPath: string): Promise<LoadedDocument> {
    const restored = await this.snapshots.read(docId, timestamp)
    const created = await this.documents.create(targetPath, restored.title)
    const written = await this.documents.write(
      created.path,
      { ...restored, docId: created.doc.docId, created: created.doc.created },
      created.mtime
    )
    if (!written.ok) throw new Error('Could not write the restored copy')

    await this.search.indexDocument(created.path, written.mtime).catch(() => {})
    return await this.documents.read(created.path)
  }
}
