import { ulid } from 'ulid'
import type { VfsAdapter } from '../vfs/types.js'
import {
  pubDocumentSchema,
  EMPTY_DOC,
  type PubDocument,
  type LoadedDocument
} from '../../shared/model/document.js'
import { countWords } from '../../shared/pm/extractText.js'
import { FORMAT_VERSION, ASSETS_DIR, DOC_EXT } from '../../shared/constants.js'
import { basename } from '../vfs/paths.js'
import type { SnapshotService } from './snapshotService.js'

export type WriteResult =
  | { ok: true; mtime: number }
  | { ok: false; reason: 'conflict'; diskMtime: number }

/** Reads and writes `.pubdoc` envelopes, with the crash- and conflict-safety around them. */
export class DocumentService {
  constructor(
    private readonly adapter: VfsAdapter,
    private readonly snapshots: SnapshotService
  ) {}

  async read(docPath: string): Promise<LoadedDocument> {
    const raw = await this.adapter.readFile(docPath)
    const doc = pubDocumentSchema.parse(JSON.parse(raw.toString('utf8')))
    const stat = await this.adapter.stat(docPath)
    return { doc, path: docPath, mtime: stat?.mtime ?? 0 }
  }

  async create(docPath: string, title?: string): Promise<LoadedDocument> {
    const finalPath = docPath.endsWith(DOC_EXT) ? docPath : `${docPath}${DOC_EXT}`
    const existing = await this.adapter.stat(finalPath)
    if (existing) throw new Error(`A file already exists at ${finalPath}`)
    const now = new Date().toISOString()
    const doc: PubDocument = {
      formatVersion: FORMAT_VERSION,
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
  async write(docPath: string, incoming: PubDocument, expectedMtime: number | null): Promise<WriteResult> {
    const stat = await this.adapter.stat(docPath)
    if (stat && expectedMtime !== null && stat.mtime !== undefined && stat.mtime !== expectedMtime) {
      return { ok: false, reason: 'conflict', diskMtime: stat.mtime }
    }

    if (stat) {
      try {
        const previousRaw = await this.adapter.readFile(docPath)
        const previous = pubDocumentSchema.parse(JSON.parse(previousRaw.toString('utf8')))
        await this.snapshots.maybeSnapshot(previous)
      } catch {
        // Unparseable previous version: nothing worth archiving.
      }
    }

    const doc: PubDocument = {
      ...incoming,
      formatVersion: FORMAT_VERSION,
      modified: new Date().toISOString(),
      wordCount: countWords(incoming.content)
    }
    await this.adapter.writeFileAtomic(docPath, serialize(doc))
    const after = await this.adapter.stat(docPath)
    return { ok: true, mtime: after?.mtime ?? Date.now() }
  }

  /** Store a pasted or dropped image inside the project and return its asset path. */
  async writeAsset(dataBase64: string, ext: string): Promise<string> {
    const safeExt = ext.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'png'
    const assetPath = `${ASSETS_DIR}/${ulid()}.${safeExt}`
    await this.adapter.writeFile(assetPath, Buffer.from(dataBase64, 'base64'))
    return assetPath
  }
}

function serialize(doc: PubDocument): Buffer {
  return Buffer.from(`${JSON.stringify(doc, null, 2)}\n`, 'utf8')
}
