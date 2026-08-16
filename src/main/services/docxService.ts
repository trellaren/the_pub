import fs from 'node:fs/promises'
import path from 'node:path'
import type { VfsAdapter } from '../vfs/types.js'
import type { DocumentService } from './documentService.js'
import type { ProjectManifest } from '../../shared/model/manifest.js'
import type { NamedStyle } from '../../shared/model/style.js'
import type { PmDoc, PmNode, Section } from '../../shared/model/document.js'
import type { ExportItem } from '../../shared/model/manuscript.js'
import { DOC_EXT, ASSETS_DIR } from '../../shared/constants.js'
import { joinRelative, basename, relativeToRoot } from '../vfs/paths.js'
import { sanitizeFileName } from '../../shared/model/filename.js'
import { importDocx, IMAGE_PLACEHOLDER_PREFIX, type ImportedImage } from '../docx/fromDocx.js'
import { exportDocx } from '../docx/toDocx.js'
import { colorForAuthor, type AuthorProfile } from '../../shared/model/author.js'
import { reconcileStyles } from '../docx/styleMap.js'
import { ASSET_PROTOCOL } from '../../shared/constants.js'
import { parseAssetUrl } from '../../shared/model/asset.js'

export interface ImportedDocument {
  path: string
  title: string
  docId: string
}

export interface ImportResult {
  imported: ImportedDocument[]
  warnings: string[]
  /** Styles the project gained. The caller persists them with the manifest. */
  styles: NamedStyle[]
  stylesAdded: number
}

/**
 * Word documents in and out.
 *
 * The conversion itself is pure and lives in `../docx/`; this is the part that
 * knows where a project is. The asymmetry is deliberate: a `.docx` being
 * imported sits *outside* the project (it is on the author's disk, wherever
 * they keep it) and is read with `fs`, while everything written lands inside
 * the project through the adapter — so import works over SFTP and FTP exactly
 * as it does locally.
 *
 * Export is the mirror image: read through the adapter, write with `fs`,
 * because the destination is wherever the author chose to save it.
 */
export class DocxService {
  constructor(
    private readonly adapter: VfsAdapter,
    private readonly documents: DocumentService,
    /**
     * The project's author registry. Word carries tracked-change authors as
     * names, so export needs ids resolved to names, and import needs the
     * reverse — names it has never seen registered so a comment shows a person
     * rather than a hash.
     */
    private readonly reviews: {
      listAuthors: () => Promise<AuthorProfile[]>
      registerAuthor: (profile: AuthorProfile) => Promise<void>
    }
  ) {}

  /**
   * Read `.docx` files from disk into the project.
   *
   * Returns the styles the project should now have rather than writing the
   * manifest itself: the session owns the manifest, and two writers of one file
   * is the bug this codebase has already designed its way out of everywhere
   * else.
   */
  async import(
    files: string[],
    targetDir: string,
    manifest: ProjectManifest
  ): Promise<ImportResult> {
    const imported: ImportedDocument[] = []
    const warnings: string[] = []
    let styles = manifest.styles
    let stylesAdded = 0

    for (const file of files) {
      const bytes = await fs.readFile(file)
      const result = importDocx(new Uint8Array(bytes))
      for (const author of result.authors) {
        await this.reviews.registerAuthor({ ...author, color: colorForAuthor(author.id) })
      }

      const reconciled = reconcileStyles(result.styles, styles)
      if (reconciled.added.length > 0) {
        styles = [...styles, ...reconciled.added]
        stylesAdded += reconciled.added.length
      }

      const assets = await this.writeImages(result.images)
      const content = rewriteDocument(result.content, reconciled.mapping, assets)
      // The page setup Word recorded for this file becomes the document's own
      // section (Phase 7) rather than a project-wide setting nothing reads —
      // an imported document keeps the page size it was actually written at.
      const sections: Section[] | undefined = result.page
        ? [{ startBlockIndex: 0, page: { ...result.page, orientation: 'portrait' as const, columns: 1 } }]
        : undefined

      const title = path.basename(file).replace(/\.docx$/i, '')
      const docPath = await this.freePath(targetDir, title)
      const created = await this.documents.create(docPath, title)
      const written = await this.documents.write(
        created.path,
        { ...created.doc, content, ...(sections ? { sections } : {}) },
        created.mtime
      )
      if (!written.ok) {
        warnings.push(`${title} could not be written: the file changed underneath the import.`)
        continue
      }

      imported.push({ path: created.path, title, docId: created.doc.docId })
      for (const warning of result.warnings) {
        // Warnings are per-file but read better as one list, so name the file
        // when there is more than one.
        const message = files.length > 1 ? `${title}: ${warning}` : warning
        if (!warnings.includes(message)) warnings.push(message)
      }
    }

    return { imported, warnings, styles, stylesAdded }
  }

  /**
   * Write project documents — and, from the manuscript panel, part headings
   * interleaved with them — to a `.docx` at an absolute path.
   *
   * A heading item becomes a synthetic single-paragraph document rather than a
   * special case in `exportDocx`: the exporter already inserts a page break
   * between every entry in the array (`toDocx.ts`), so a part heading lands on
   * its own page for free, exactly as a part page should.
   */
  async export(items: ExportItem[], file: string, manifest: ProjectManifest): Promise<void> {
    const documents = []
    // The first real (non-heading) document's own section, if it has one —
    // what makes a document's own page setup and headers/footers win over
    // the project default once an author has actually set one.
    let firstSection: Section | undefined
    for (const item of items) {
      if (item.kind === 'heading') {
        documents.push({
          title: item.title,
          content: headingDocument(item.title, item.level, manifest.styles, item.numbered)
        })
        continue
      }
      const loaded = await this.documents.read(item.path)
      documents.push({ title: loaded.doc.title, content: loaded.doc.content })
      if (!firstSection) firstSection = loaded.doc.sections?.[0]
    }

    // Images are read up front: `exportDocx` resolves them synchronously,
    // because the library's run constructor takes bytes rather than a promise.
    const images = await this.readImages(documents.map((entry) => entry.content))

    const authors = Object.fromEntries(
      (await this.reviews.listAuthors()).map((author) => [author.id, author.name])
    )
    const buffer = await exportDocx({
      documents,
      authors,
      styles: manifest.styles,
      page: firstSection
        ? firstSection.page
        : {
            width: manifest.settings.pageWidth,
            height: manifest.settings.pageHeight,
            margin: manifest.settings.pageMargin
          },
      header: firstSection?.header,
      footer: firstSection?.footer,
      readImage: (src) => images.get(src) ?? null
    })

    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, buffer)
  }

  /** Store each imported image in the project and map its part name to an asset URL. */
  private async writeImages(images: ImportedImage[]): Promise<Map<string, string>> {
    const written = new Map<string, string>()
    for (const image of images) {
      try {
        const assetPath = await this.documents.writeAsset(
          Buffer.from(image.data).toString('base64'),
          image.extension
        )
        written.set(image.part, assetPath)
      } catch {
        // A single unreadable image must not abandon the whole chapter.
      }
    }
    return written
  }

  private async readImages(
    documents: PmDoc[]
  ): Promise<Map<string, { data: Uint8Array; type: 'png' | 'jpg' | 'gif' | 'bmp' }>> {
    const found = new Map<string, { data: Uint8Array; type: 'png' | 'jpg' | 'gif' | 'bmp' }>()
    const sources = new Set<string>()
    for (const document of documents) collectImageSources(document.content ?? [], sources)

    for (const src of sources) {
      const relative = this.assetPathFor(src)
      if (!relative) continue
      try {
        const data = await this.adapter.readFile(relative)
        found.set(src, { data: new Uint8Array(data), type: imageType(relative) })
      } catch {
        // A missing image is a gap in the exported file, not a failed export.
      }
    }
    return found
  }

  /**
   * Turn an image `src` back into a project-relative path.
   *
   * The renderer sees images as `pub-asset://` URLs, because it has no
   * `file://` access. Undoing that is the only way to find the bytes again at
   * export time. Two URL shapes exist — the current token-plus-relative-path
   * form carries the path outright, and the legacy form encodes an absolute
   * local path that has to be unwound against the project root.
   */
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
    // A remote project's root is a URI rather than a path, so the tidy
    // relative-to-root answer only works locally; falling back to the assets
    // segment covers the rest.
    try {
      const relative = relativeToRoot(this.adapter.root, absolute)
      if (relative && !relative.startsWith('..')) return relative
    } catch {
      // Fall through to the assets-segment search.
    }
    const marker = absolute.replace(/\\/g, '/').lastIndexOf(`${ASSETS_DIR}/`)
    return marker === -1 ? null : absolute.replace(/\\/g, '/').slice(marker)
  }

  /** A path in `targetDir` for this title that no file already occupies. */
  private async freePath(targetDir: string, title: string): Promise<string> {
    const stem = sanitizeFileName(title, 'Imported')
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const name = attempt === 0 ? `${stem}${DOC_EXT}` : `${stem} (${attempt})${DOC_EXT}`
      const candidate = joinRelative(targetDir, name)
      if (!(await this.adapter.stat(candidate))) return candidate
    }
    return joinRelative(targetDir, `${stem} (${Date.now()})${DOC_EXT}`)
  }
}

/**
 * A one-paragraph document for a part heading.
 *
 * Resolved against the project's own styles by `headingLevel` rather than a
 * hard-coded id, so a project that renamed or replaced "Heading 1" still gets
 * a heading that matches the rest of the book — the same reason a document's
 * own headings resolve by `styleId` instead of by name. A project with no
 * style at the requested level exports the title unstyled rather than
 * failing the whole compile over it.
 */
function headingDocument(title: string, level: number, styles: NamedStyle[], numbered: boolean): PmDoc {
  const style = styles.find((candidate) => candidate.headingLevel === level)
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        // `unnumbered` isn't a real editor attr — this synthetic document
        // never round-trips through the app's own schema, only straight into
        // `exportDocx`, so it's a private signal to `toDocx.ts` alone: don't
        // draw a number from the style even if the style itself is numbered.
        attrs: { ...(style ? { styleId: style.id } : {}), ...(numbered ? {} : { unnumbered: true }) },
        content: [{ type: 'text', text: title }]
      }
    ]
  }
}

/* ---------------------------------------------------------------- rewrite */

/**
 * Re-point a freshly imported document at the project's own ids.
 *
 * Style ids arrive as Word's; image sources arrive as placeholders. Both are
 * rewritten in one walk rather than two, so a large chapter is traversed once.
 */
function rewriteDocument(
  content: PmDoc,
  styleMapping: Map<string, string>,
  assets: Map<string, string>
): PmDoc {
  return { ...content, content: (content.content ?? []).map((node) => rewriteNode(node, styleMapping, assets)) }
}

function rewriteNode(
  node: PmNode,
  styleMapping: Map<string, string>,
  assets: Map<string, string>
): PmNode {
  const next: PmNode = { ...node }

  if (node.attrs) {
    const attrs = { ...node.attrs }
    if (typeof attrs.styleId === 'string') {
      const mapped = styleMapping.get(attrs.styleId)
      // A style the document referred to but never defined leaves the block
      // unstyled, which renders as body text rather than as nothing.
      if (mapped) attrs.styleId = mapped
      else delete attrs.styleId
    }
    if (typeof attrs.src === 'string' && attrs.src.startsWith(IMAGE_PLACEHOLDER_PREFIX)) {
      const part = attrs.src.slice(IMAGE_PLACEHOLDER_PREFIX.length)
      const asset = assets.get(part)
      if (asset) attrs.src = asset
      else return { type: 'paragraph' }
    }
    next.attrs = attrs
  }

  if (node.content) next.content = node.content.map((child) => rewriteNode(child, styleMapping, assets))
  return next
}

function collectImageSources(nodes: PmNode[], found: Set<string>): void {
  for (const node of nodes) {
    if (node.type === 'image' && typeof node.attrs?.src === 'string') found.add(node.attrs.src)
    if (node.content) collectImageSources(node.content, found)
  }
}

function imageType(filePath: string): 'png' | 'jpg' | 'gif' | 'bmp' {
  const extension = basename(filePath).split('.').pop()?.toLowerCase()
  if (extension === 'jpg' || extension === 'jpeg') return 'jpg'
  if (extension === 'gif') return 'gif'
  if (extension === 'bmp') return 'bmp'
  return 'png'
}
