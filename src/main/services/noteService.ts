import { ulid } from 'ulid'
import type { VfsAdapter } from '../vfs/types.js'
import { noteFileSchema, noteSchema, EMPTY_NOTE_FILE, type Note, type NoteFile } from '../../shared/model/note.js'
import { readVersionedJson, KeyedSerialQueue, jsonBytes } from './versionedJson.js'
import { TooNewError } from './jsonCollectionService.js'
import { findAnchor } from '../../shared/pm/anchors.js'
import type { PmDoc } from '../../shared/model/document.js'
import { NOTES_DIR } from '../../shared/constants.js'

/**
 * Notes, one file per document.
 *
 * Unlike `EntityService`'s single roster, this keeps a cache **per document**,
 * loaded lazily on first use rather than all at once for the whole project —
 * a project with a thousand chapters should not pay for a thousand note files
 * on startup when a session opens three of them.
 */
export class NoteService {
  private cache = new Map<string, NoteFile>()
  /** Files a newer build wrote: shown as far as they parse, never written back. */
  private tooNew = new Set<string>()
  private readonly writes = new KeyedSerialQueue()

  constructor(private readonly adapter: VfsAdapter) {}

  private pathFor(docId: string): string {
    return `${NOTES_DIR}/${docId}.json`
  }

  private async loadFile(docId: string): Promise<NoteFile> {
    const key = docId
    const cached = this.cache.get(key)
    if (cached) return cached
    const read = await readVersionedJson(this.adapter, this.pathFor(docId), 'notes', noteFileSchema, () => structuredClone(EMPTY_NOTE_FILE))
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
      await this.adapter.mkdir(NOTES_DIR).catch(() => {})
      await this.adapter.writeFileAtomic(this.pathFor(docId), bytes)
    })
  }


  async listForDoc(docId: string): Promise<Note[]> {
    const file = await this.loadFile(docId)
    return structuredClone(file.notes)
  }

  async create(docId: string, anchorId: string, anchorText: string, blockIndex: number): Promise<Note> {
    const file = await this.loadFile(docId)
    const now = new Date().toISOString()
    const note = noteSchema.parse({
      id: ulid(),
      docId,
      anchorId,
      anchorText,
      blockIndex,
      created: now,
      modified: now
    })
    file.notes = [...file.notes, note]
    await this.flush(docId)
    return structuredClone(note)
  }

  async save(docId: string, incoming: Note): Promise<Note> {
    const file = await this.loadFile(docId)
    const existing = file.notes.find((candidate) => candidate.id === incoming.id)
    const note = noteSchema.parse({
      ...incoming,
      docId,
      created: existing?.created ?? incoming.created,
      modified: new Date().toISOString()
    })
    file.notes = existing
      ? file.notes.map((candidate) => (candidate.id === note.id ? note : candidate))
      : [...file.notes, note]
    await this.flush(docId)
    return structuredClone(note)
  }

  async remove(docId: string, noteId: string): Promise<void> {
    const file = await this.loadFile(docId)
    file.notes = file.notes.filter((note) => note.id !== noteId)
    await this.flush(docId)
  }

  /**
   * Re-check every note's anchor against the document as just written.
   *
   * Called after every save of the document itself, the way search indexing
   * is — cheap for the handful of notes a chapter actually has, and it means
   * "orphaned" is never more than one save stale. A note whose anchor is gone
   * is marked, never deleted or rewritten; re-attaching it is a person's
   * decision, not something a save silently does on their behalf.
   *
   * Returns `null` when nothing changed, so a caller deciding whether to tell
   * the renderer can skip the broadcast on the common case — most saves touch
   * no note at all — rather than firing on every autosave tick of a document
   * that merely *has* notes.
   */
  async reconcile(docId: string, content: PmDoc): Promise<Note[] | null> {
    const file = await this.loadFile(docId)
    if (file.notes.length === 0) return null

    let changed = false
    file.notes = file.notes.map((note) => {
      const location = findAnchor(content, note.anchorId)
      if (!location) {
        if (note.orphaned) return note
        changed = true
        return { ...note, orphaned: true }
      }
      if (!note.orphaned && location.text === note.anchorText && location.blockIndex === note.blockIndex) {
        return note
      }
      changed = true
      return { ...note, orphaned: false, anchorText: location.text, blockIndex: location.blockIndex }
    })
    if (!changed) return null
    await this.flush(docId)
    return structuredClone(file.notes)
  }
}
