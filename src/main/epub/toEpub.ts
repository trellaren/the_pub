import { zipSync, strToU8, type Zippable, type ZippableFile } from 'fflate'
import type { PmDoc } from '../../shared/model/document.js'
import type { NamedStyle } from '../../shared/model/style.js'
import type { Publication } from '../../shared/model/manifest.js'
import { documentToXhtml } from './xhtml.js'
import { buildStylesheet } from './css.js'
import { buildOpf, type OpfChapter, type OpfManifestEntry } from './opf.js'
import { buildNavXhtml, buildNcx, type NavChapter } from './nav.js'

/**
 * Writing an `.epub`.
 *
 * A sibling of `toDocx.ts`, with no knowledge of a project: it takes
 * documents, styles and publication metadata, and returns bytes. The caller
 * (an `epubService`, mirroring `docxService`) is the one that turns a
 * project's `ExportItem[]` into the `ExportDocument[]` this takes — the same
 * split `docxService.export` already makes for `.docx`.
 */

export interface ExportDocument {
  title: string
  content: PmDoc
}

export interface ExportOptions {
  documents: ExportDocument[]
  styles: NamedStyle[]
  publication: Publication
  title: string
  /** Fixed so two exports of an unchanged book are byte-identical. Defaults to the epoch. */
  modified?: string
  /** A fixed book id (a real export mints a stable one from the manifest id) so output is deterministic across runs. */
  bookId: string
  /** Resolve an image `src` to bytes. Absent images are skipped, not fatal — mirrors `toDocx.ts`. */
  readImage?: (src: string) => { data: Uint8Array; extension: string } | null
  /** Project-relative path into `ASSETS_DIR`, if the publication has a cover. */
  readCover?: () => { data: Uint8Array; extension: string } | null
}

const OEBPS = 'OEBPS'
/** Zip's DOS date field only covers 1980-2099; earliest valid, and fixed so exports are deterministic. */
const FIXED_MTIME = new Date('1980-01-01T00:00:00Z')

export async function exportEpub(options: ExportOptions): Promise<Buffer> {
  const modified = options.modified ?? '1970-01-01T00:00:00Z'
  const files: Zippable = {}
  // Fixed mtime on every entry, and a fixed compression level, so two exports
  // of an unchanged book are byte-identical.
  const store = (path: string, data: string | Uint8Array, level: 0 | 6 = 6): void => {
    const bytes = typeof data === 'string' ? strToU8(data) : data
    files[path] = [bytes, { mtime: FIXED_MTIME, level }] as ZippableFile
  }

  // The mimetype entry must be the first thing in the archive and stored,
  // never compressed — the one hard requirement of the EPUB container format.
  store('mimetype', strToU8('application/epub+zip'), 0)
  store(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles>
    <rootfile full-path="${OEBPS}/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`
  )

  const chapters: OpfChapter[] = []
  const navChapters: NavChapter[] = []
  const extraManifest: OpfManifestEntry[] = []
  const usedImages = new Map<string, string>() // src -> image id/href, deduped across chapters
  let footnoteCounter = 0

  options.documents.forEach((document, index) => {
    const href = `text/chapter-${index + 1}.xhtml`
    const id = `chap${index + 1}`
    const prefix = `c${index + 1}-`
    const result = documentToXhtml(document.content, options.styles, prefix)
    footnoteCounter += result.footnotes.length

    const footnotesXhtml = result.footnotes.map((entry) => entry.body).join('\n')
    const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>${escapeXml(document.title)}</title>
  <link rel="stylesheet" type="text/css" href="../styles/stylesheet.css"/>
</head>
<body>
<h1 class="chapter-title">${escapeXml(document.title)}</h1>
${result.body}
${footnotesXhtml}
</body>
</html>
`
    store(`${OEBPS}/${href}`, xhtml)
    chapters.push({ id, href, title: document.title })
    navChapters.push({ href, title: document.title, doc: document.content })

    for (const src of result.imageSrcs) {
      if (usedImages.has(src)) continue
      const image = options.readImage?.(src)
      if (!image) continue
      const name = src.split('/').pop() ?? `image-${usedImages.size + 1}`
      const imageId = `img-${usedImages.size + 1}`
      usedImages.set(src, name)
      store(`${OEBPS}/images/${name}`, image.data)
      extraManifest.push({ id: imageId, href: `images/${name}`, mediaType: mediaTypeFor(image.extension) })
    }
  })

  store(`${OEBPS}/styles/stylesheet.css`, buildStylesheet(options.styles))

  let coverImageId: string | undefined
  const cover = options.readCover?.()
  if (cover) {
    coverImageId = 'cover-image'
    const ext = cover.extension.replace(/^\./, '')
    store(`${OEBPS}/images/cover.${ext}`, cover.data)
    extraManifest.push({
      id: coverImageId,
      href: `images/cover.${ext}`,
      mediaType: mediaTypeFor(ext),
      properties: 'cover-image'
    })
  }

  store(`${OEBPS}/nav.xhtml`, buildNavXhtml(navChapters, options.styles, cover ? chapters[0]?.href : undefined))
  store(`${OEBPS}/toc.ncx`, buildNcx(navChapters, options.styles, options.bookId, options.title))
  store(
    `${OEBPS}/content.opf`,
    buildOpf({
      title: options.title,
      publication: options.publication,
      chapters,
      extraManifest,
      modified,
      bookId: options.bookId,
      coverImageId
    })
  )

  const zipped = zipSync(files)
  return Buffer.from(zipped)
}

function mediaTypeFor(extension: string): string {
  const ext = extension.replace(/^\./, '').toLowerCase()
  switch (ext) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'svg':
      return 'image/svg+xml'
    default:
      return 'application/octet-stream'
  }
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
