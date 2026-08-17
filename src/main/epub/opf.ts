import type { Publication } from '../../shared/model/manifest.js'

/**
 * The package document: metadata, manifest, spine. The counterpart of
 * `toDocx.ts`'s document-level assembly, built from `flattenManuscript`'s
 * output the same way `docxService.export` is — spine order is exactly
 * chapter-file order, because that *is* what "the book, in reading order"
 * means for EPUB.
 */

export interface OpfChapter {
  id: string
  href: string
  title: string
}

export interface OpfManifestEntry {
  id: string
  href: string
  mediaType: string
  properties?: string
}

export interface BuildOpfOptions {
  title: string
  publication: Publication
  chapters: OpfChapter[]
  extraManifest: OpfManifestEntry[]
  modified: string
  bookId: string
  coverImageId?: string
}

export function buildOpf(options: BuildOpfOptions): string {
  const { title, publication, chapters, extraManifest, modified, bookId } = options
  const language = publication.language || 'en'

  const metaEntries: string[] = [
    `<dc:identifier id="book-id">urn:uuid:${escape(bookId)}</dc:identifier>`,
    `<dc:title>${escape(title)}</dc:title>`,
    `<dc:language>${escape(language)}</dc:language>`,
    `<meta property="dcterms:modified">${escape(modified)}</meta>`
  ]
  if (publication.subtitle) metaEntries.push(`<meta property="title-type" refines="#book-id">subtitle</meta>`)
  if (publication.authorName) metaEntries.push(`<dc:creator id="creator">${escape(publication.authorName)}</dc:creator>`)
  if (publication.publisher) metaEntries.push(`<dc:publisher>${escape(publication.publisher)}</dc:publisher>`)
  if (publication.isbn) metaEntries.push(`<dc:identifier>urn:isbn:${escape(publication.isbn)}</dc:identifier>`)
  if (publication.rights) metaEntries.push(`<dc:rights>${escape(publication.rights)}</dc:rights>`)
  if (publication.publicationDate) metaEntries.push(`<dc:date>${escape(publication.publicationDate)}</dc:date>`)
  if (publication.description) metaEntries.push(`<dc:description>${escape(publication.description)}</dc:description>`)
  if (publication.series) {
    metaEntries.push(
      `<meta property="belongs-to-collection" id="series">${escape(publication.series)}</meta>`,
      `<meta refines="#series" property="collection-type">series</meta>`
    )
    if (publication.seriesNumber !== undefined) {
      metaEntries.push(`<meta refines="#series" property="group-position">${publication.seriesNumber}</meta>`)
    }
  }
  if (options.coverImageId) metaEntries.push(`<meta name="cover" content="${escape(options.coverImageId)}"/>`)

  const manifestEntries: string[] = [
    `<item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>`,
    `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
    ...chapters.map(
      (chapter) => `<item id="${chapter.id}" href="${chapter.href}" media-type="application/xhtml+xml"/>`
    ),
    ...extraManifest.map(
      (entry) =>
        `<item id="${entry.id}" href="${entry.href}" media-type="${entry.mediaType}"${
          entry.properties ? ` properties="${entry.properties}"` : ''
        }/>`
    )
  ]

  const spineEntries = chapters.map((chapter) => `<itemref idref="${chapter.id}"/>`)

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${escape(language)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    ${metaEntries.join('\n    ')}
  </metadata>
  <manifest>
    ${manifestEntries.join('\n    ')}
  </manifest>
  <spine toc="ncx">
    ${spineEntries.join('\n    ')}
  </spine>
</package>
`
}

function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
