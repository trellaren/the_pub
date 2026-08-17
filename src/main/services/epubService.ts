import fs from 'node:fs/promises'
import path from 'node:path'
import type { VfsAdapter } from '../vfs/types.js'
import type { DocumentService } from './documentService.js'
import type { ProjectManifest } from '../../shared/model/manifest.js'
import type { PmNode } from '../../shared/model/document.js'
import type { ExportItem } from '../../shared/model/manuscript.js'
import { ASSETS_DIR } from '../../shared/constants.js'
import { exportEpub, type ExportDocument } from '../epub/toEpub.js'
import { ASSET_PROTOCOL } from '../../shared/constants.js'
import { parseAssetUrl } from '../../shared/model/asset.js'
import { relativeToRoot, basename } from '../vfs/paths.js'

/**
 * `ExportItem[]` + manifest in, EPUB bytes out.
 *
 * The glue between a project (`flattenManuscript`'s output, the manifest's
 * styles and `publication` block) and `toEpub.ts`, which knows nothing about
 * a project at all. Mirrors `DocxService.export` in shape and in the asymmetry
 * it inherits: the project's own files are read through the `VfsAdapter` so
 * this works over SFTP/FTP exactly as locally, and the destination `.epub` is
 * wherever the author chose on their own disk, written with `fs`.
 */
export class EpubService {
  constructor(
    private readonly adapter: VfsAdapter,
    private readonly documents: DocumentService
  ) {}

  async export(items: ExportItem[], file: string, manifest: ProjectManifest): Promise<void> {
    const documents: ExportDocument[] = []
    for (const item of items) {
      if (item.kind === 'heading') {
        documents.push({ title: item.title, content: headingDocument(item.title) })
        continue
      }
      const loaded = await this.documents.read(item.path)
      documents.push({ title: loaded.doc.title, content: loaded.doc.content })
    }

    const images = await this.readImages(documents)
    const cover = manifest.publication.coverImagePath
      ? await this.readAsset(manifest.publication.coverImagePath)
      : null

    const buffer = await exportEpub({
      documents,
      styles: manifest.styles,
      publication: manifest.publication,
      title: manifest.name,
      bookId: manifest.id,
      readImage: (src) => images.get(src) ?? null,
      readCover: cover ? () => cover : undefined
    })

    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, buffer)
  }

  private async readImages(
    documents: ExportDocument[]
  ): Promise<Map<string, { data: Uint8Array; extension: string }>> {
    const sources = new Set<string>()
    for (const document of documents) collectImageSources(document.content.content ?? [], sources)

    const found = new Map<string, { data: Uint8Array; extension: string }>()
    for (const src of sources) {
      const relative = this.assetPathFor(src)
      if (!relative) continue
      const image = await this.readAsset(relative)
      if (image) found.set(src, image)
    }
    return found
  }

  private async readAsset(relative: string): Promise<{ data: Uint8Array; extension: string } | null> {
    try {
      const data = await this.adapter.readFile(relative)
      const extension = basename(relative).split('.').pop() ?? 'png'
      return { data: new Uint8Array(data), extension }
    } catch {
      // A missing image is a gap in the exported book, not a failed export —
      // the same tolerance `DocxService.export` extends to images.
      return null
    }
  }

  /** Mirrors `DocxService.assetPathFor` — see its comment for why two URL shapes exist. */
  private assetPathFor(src: string): string | null {
    if (!src.startsWith(`${ASSET_PROTOCOL}://`)) {
      return src.startsWith(`${ASSETS_DIR}/`) ? src : null
    }
    const parsed = parseAssetUrl(src)
    if (!parsed) return null
    if (parsed.kind === 'project') return parsed.path
    let absolute: string
    try {
      absolute = Buffer.from(parsed.encoded, 'base64url').toString('utf8')
    } catch {
      return null
    }
    try {
      const relative = relativeToRoot(this.adapter.root, absolute)
      if (relative && !relative.startsWith('..')) return relative
    } catch {
      // Fall through to the assets-segment search.
    }
    const marker = absolute.replace(/\\/g, '/').lastIndexOf(`${ASSETS_DIR}/`)
    return marker === -1 ? null : absolute.replace(/\\/g, '/').slice(marker)
  }
}

/** A one-paragraph document for a part heading, mirroring `docxService.ts`'s `headingDocument`. */
function headingDocument(title: string) {
  return {
    type: 'doc' as const,
    content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: title }] }]
  }
}

function collectImageSources(nodes: PmNode[], found: Set<string>): void {
  for (const node of nodes) {
    if (node.type === 'image' && typeof node.attrs?.src === 'string') found.add(node.attrs.src)
    if (node.content) collectImageSources(node.content, found)
  }
}
