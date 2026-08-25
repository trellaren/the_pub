import { ulid } from 'ulid'
import type { VfsAdapter } from '../vfs/types.js'
import {
  sourceFileSchema,
  cslItemSchema,
  isCheckable,
  withProvisional,
  EMPTY_SOURCE_FILE,
  type SourceFile,
  type CslItem
} from '../../shared/model/source.js'
import {
  researchAttachmentSchema,
  pubAttachmentsSchema,
  captureSchema,
  PUB_ATTACHMENTS_KEY,
  type ResearchAttachment,
  type Capture
} from '../../shared/model/research.js'
import { SOURCES_FILE, RESEARCH_DIR } from '../../shared/constants.js'
import { JsonCollectionService } from './jsonCollectionService.js'

/** `.thepub/research/<sourceId>/`, never inside the project's own file tree — see `research.ts`. */
export function attachmentDir(sourceId: string): string {
  return `${RESEARCH_DIR}/${sourceId}`
}

/** The PDF bytes for a `pdf` attachment. */
export function attachmentPdfPath(sourceId: string, attachmentId: string): string {
  return `${attachmentDir(sourceId)}/${attachmentId}.pdf`
}

/** The captured text/title for a `capture` attachment. */
export function attachmentCapturePath(sourceId: string, attachmentId: string): string {
  return `${attachmentDir(sourceId)}/${attachmentId}.capture.json`
}

function attachmentsOf(item: CslItem): ResearchAttachment[] {
  const raw = (item as Record<string, unknown>)[PUB_ATTACHMENTS_KEY]
  const parsed = pubAttachmentsSchema.safeParse(raw)
  return parsed.success ? parsed.data : []
}

function withAttachments(item: CslItem, attachments: ResearchAttachment[]): CslItem {
  return { ...item, [PUB_ATTACHMENTS_KEY]: attachments }
}

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
   * Add a source the assistant attributed a claim to.
   *
   * Refused outright when there is nothing to check it against. The model does
   * not browse, so this is a citation it has *asserted*, and an assertion with
   * no URL, no DOI and no identifiable work is a sentence dressed as a
   * reference — worse in a bibliography than a note in a chat, because it
   * looks like it was verified.
   */
  async addProvisional(incoming: CslItem): Promise<CslItem> {
    const item = cslItemSchema.parse({ ...incoming, id: incoming.id || ulid() })
    if (!isCheckable(item)) {
      throw new Error(
        'A source needs a URL, a DOI, an ISBN, or a title with an author or publisher — something a person can check.'
      )
    }
    const stored = withProvisional(item, true)
    this.upsert(stored)
    await this.flush()
    return structuredClone(stored)
  }

  /** The writer has checked the citation. Clearing the flag is all this does. */
  async accept(id: string): Promise<CslItem> {
    const existing = this.get(id)
    if (!existing) throw new Error('That source no longer exists.')
    const accepted = withProvisional(existing, false)
    this.upsert(accepted)
    await this.flush()
    return structuredClone(accepted)
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

  /** A source's attachment index, read out of its `_pubAttachments` catchall entry. */
  listAttachments(sourceId: string): ResearchAttachment[] {
    const item = this.get(sourceId)
    return item ? attachmentsOf(item) : []
  }

  /**
   * Add a PDF attachment: writes the bytes under `.thepub/research/<sourceId>/`
   * through the `VfsAdapter` — never raw `fs`, so this works unchanged on
   * SFTP, FTP and OneDrive projects — then records it in the source's index.
   */
  async addPdfAttachment(sourceId: string, bytes: Buffer, label: string): Promise<ResearchAttachment> {
    const item = this.get(sourceId)
    if (!item) throw new Error(`No such source: ${sourceId}`)

    const attachment = researchAttachmentSchema.parse({
      id: ulid(),
      sourceId,
      kind: 'pdf',
      title: item.title ?? '',
      label,
      added: new Date().toISOString()
    })
    await this.adapter.mkdir(attachmentDir(sourceId)).catch(() => {})
    await this.adapter.writeFileAtomic(attachmentPdfPath(sourceId, attachment.id), bytes)
    this.upsert(withAttachments(item, [...attachmentsOf(item), attachment]))
    await this.flush()
    return attachment
  }

  /** Add a web-capture attachment, and merge its `URL`/`accessed` into the source's own CSL fields. */
  async addCaptureAttachment(sourceId: string, capture: Capture, label: string): Promise<ResearchAttachment> {
    const item = this.get(sourceId)
    if (!item) throw new Error(`No such source: ${sourceId}`)

    const parsedCapture = captureSchema.parse(capture)
    const attachment = researchAttachmentSchema.parse({
      id: ulid(),
      sourceId,
      kind: 'capture',
      title: parsedCapture.title,
      label,
      added: new Date().toISOString()
    })
    await this.adapter.mkdir(attachmentDir(sourceId)).catch(() => {})
    await this.adapter.writeFileAtomic(
      attachmentCapturePath(sourceId, attachment.id),
      Buffer.from(`${JSON.stringify(parsedCapture, null, 2)}\n`, 'utf8')
    )

    const [year, month, day] = parsedCapture.accessed.split('-').map((part) => Number(part))
    const dateParts = [year, month, day].filter((part) => Number.isFinite(part))
    this.upsert(
      withAttachments(
        { ...item, URL: parsedCapture.url, accessed: { 'date-parts': [dateParts] } },
        [...attachmentsOf(item), attachment]
      )
    )
    await this.flush()
    return attachment
  }

  /** The stored capture text/title for a `capture` attachment. */
  async readCapture(sourceId: string, attachmentId: string): Promise<Capture> {
    const raw = await this.adapter.readFile(attachmentCapturePath(sourceId, attachmentId))
    return captureSchema.parse(JSON.parse(raw.toString('utf8')))
  }

  /** The PDF bytes for a `pdf` attachment. */
  async readPdfAttachment(sourceId: string, attachmentId: string): Promise<Buffer> {
    return this.adapter.readFile(attachmentPdfPath(sourceId, attachmentId))
  }

  /** Remove an attachment's file(s) and its index entry. Never fails if the file is already gone. */
  async removeAttachment(sourceId: string, attachmentId: string): Promise<void> {
    const item = this.get(sourceId)
    if (!item) return
    const attachment = attachmentsOf(item).find((candidate) => candidate.id === attachmentId)
    if (!attachment) return

    const path = attachment.kind === 'pdf' ? attachmentPdfPath(sourceId, attachmentId) : attachmentCapturePath(sourceId, attachmentId)
    await this.adapter.delete(path).catch(() => {})
    this.upsert(withAttachments(item, attachmentsOf(item).filter((candidate) => candidate.id !== attachmentId)))
    await this.flush()
  }
}
