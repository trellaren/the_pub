import { ulid } from 'ulid'
import type { VfsAdapter } from '../vfs/types.js'
import {
  pubDocumentSchema,
  EMPTY_DOC,
  type PubDocument,
  type LoadedDocument
} from '../../shared/model/document.js'
import { countWords } from '../../shared/pm/extractText.js'
import { unionProvenance } from '../../shared/model/provenance.js'
import { migrate } from '../../shared/model/migrate.js'
import { FORMAT_VERSIONS, ASSETS_DIR, DOC_EXT } from '../../shared/constants.js'
import { basename } from '../vfs/paths.js'
import type { SnapshotService } from './snapshotService.js'

/** Upper bound on one imported image's decoded size. */
const MAX_ASSET_BYTES = 20 * 1024 * 1024

const READ_ATTEMPTS = 3

export type WriteResult =
  | { ok: true; mtime: number }
  | { ok: false; reason: 'conflict'; diskMtime: number }
  | { ok: false; reason: 'format-too-new'; diskVersion: number }

/** Reads and writes `.pubdoc` envelopes, with the crash- and conflict-safety around them. */
export class DocumentService {
  private readonly writing = new Map<string, Promise<unknown>>()

  constructor(
    private readonly adapter: VfsAdapter,
    private readonly snapshots: SnapshotService
  ) {}

  /**
   * The mtime returned is the conflict baseline for the next save, so it has to
   * belong to the bytes actually read: a stat taken only afterwards could pair
   * an old body with a newer writer's mtime, and the next save would silently
   * overwrite that writer.
   */
  async read(docPath: string): Promise<LoadedDocument> {
    for (let attempt = 1; ; attempt += 1) {
      const before = await this.adapter.stat(docPath)
      const raw = await this.adapter.readFile(docPath)
      const after = await this.adapter.stat(docPath)
      const stable = before?.mtime === after?.mtime && before?.size === after?.size
      if (!stable && attempt < READ_ATTEMPTS) continue
      const { value } = migrate('document', JSON.parse(raw.toString('utf8')))
      const doc = pubDocumentSchema.parse(value)
      // Still moving after every attempt: a baseline of 0 never matches, so the
      // next save surfaces a conflict instead of trusting a mismatched pair.
      return { doc, path: docPath, mtime: stable ? (after?.mtime ?? 0) : 0 }
    }
  }

  async create(docPath: string, title?: string): Promise<LoadedDocument> {
    const finalPath = docPath.endsWith(DOC_EXT) ? docPath : `${docPath}${DOC_EXT}`
    const existing = await this.adapter.stat(finalPath)
    if (existing) throw new Error(`A file already exists at ${finalPath}`)
    const now = new Date().toISOString()
    const doc: PubDocument = {
      formatVersion: FORMAT_VERSIONS.document,
      docId: ulid(),
      title: title ?? basename(finalPath).replace(new RegExp(`${DOC_EXT}$`), ''),
      created: now,
      modified: now,
      wordCount: 0,
      content: structuredClone(EMPTY_DOC)
    }
    await this.adapter.writeFileAtomic(finalPath, serialize(doc))
    const stat = await this.adapter.stat(finalPath)
    return { doc, path: finalPath, mtime: stat?.mtime ?? 0 }
  }

  /**
   * Persist a document.
   *
   * `expectedMtime` is the mtime the renderer last saw. If the file on disk has
   * moved on — a sync client, another editor, a second window — the write is
   * refused rather than silently overwriting someone else's work, and the
   * renderer surfaces a keep-mine/reload choice.
   */
  write(docPath: string, incoming: PubDocument, expectedMtime: number | null): Promise<WriteResult> {
    // Two saves of one document interleaving would both pass the mtime check
    // before either wrote, and the second would overwrite the first unseen.
    const previous = this.writing.get(docPath) ?? Promise.resolve()
    const next = previous.then(
      () => this.writeNow(docPath, incoming, expectedMtime),
      () => this.writeNow(docPath, incoming, expectedMtime)
    )
    const settled = next.catch(() => {})
    this.writing.set(docPath, settled)
    void settled.then(() => {
      if (this.writing.get(docPath) === settled) this.writing.delete(docPath)
    })
    return next
  }

  private async writeNow(
    docPath: string,
    incoming: PubDocument,
    expectedMtime: number | null
  ): Promise<WriteResult> {
    const stat = await this.adapter.stat(docPath)
    if (stat && expectedMtime !== null && stat.mtime !== undefined && stat.mtime !== expectedMtime) {
      return { ok: false, reason: 'conflict', diskMtime: stat.mtime }
    }

    let provenance = incoming.provenance
    if (stat) {
      const previousRaw = await this.adapter.readFile(docPath)
      let previousJson: unknown
      try {
        previousJson = JSON.parse(previousRaw.toString('utf8'))
      } catch {
        previousJson = undefined
      }

      if (previousJson !== undefined) {
        // Checked before anything else touches the file: a version this build
        // doesn't understand must never be snapshotted with today's (possibly
        // lossy) schema, let alone overwritten.
        const { value, tooNew } = migrate('document', previousJson)
        if (tooNew) {
          const diskVersion =
            (previousJson as { formatVersion?: number }).formatVersion ?? FORMAT_VERSIONS.document
          return { ok: false, reason: 'format-too-new', diskVersion }
        }
        try {
          const previous = pubDocumentSchema.parse(value)
          await this.snapshots.maybeSnapshot(previous)
          // The one place the log is enforced: whatever the caller sends, the
          // entries already on disk come along. A renderer with a stale
          // envelope, or one that dropped the field, cannot shorten it.
          provenance = unionProvenance(previous.provenance, incoming.provenance)
        } catch {
          // Unparseable previous version: nothing worth archiving.
        }
      }
    }

    const doc: PubDocument = {
      ...incoming,
      ...(provenance ? { provenance } : {}),
      formatVersion: FORMAT_VERSIONS.document,
      modified: new Date().toISOString(),
      wordCount: countWords(incoming.content)
    }
    await this.adapter.writeFileAtomic(docPath, serialize(doc))
    const after = await this.adapter.stat(docPath)
    return { ok: true, mtime: after?.mtime ?? Date.now() }
  }

  /** Store a pasted or dropped image inside the project and return its asset path. */
  async writeAsset(dataBase64: string, ext: string): Promise<string> {
    // Base64 through IPC costs a third over the raw bytes, and a decoded
    // colossus would sit in renderer memory, IPC and the write path at once.
    // Generous for any real cover or map scan; refused readably beyond that.
    if (dataBase64.length > (MAX_ASSET_BYTES / 3) * 4) {
      throw new Error(`That image is too large — the limit is ${MAX_ASSET_BYTES / (1024 * 1024)} MB.`)
    }
    const safeExt = ext.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'png'
    const assetPath = `${ASSETS_DIR}/${ulid()}.${safeExt}`
    await this.adapter.writeFile(assetPath, Buffer.from(dataBase64, 'base64'))
    return assetPath
  }
}

function serialize(doc: PubDocument): Buffer {
  return Buffer.from(`${JSON.stringify(doc, null, 2)}\n`, 'utf8')
}
