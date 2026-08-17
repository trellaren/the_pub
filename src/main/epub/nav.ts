import type { PmDoc } from '../../shared/model/document.js'
import type { NamedStyle } from '../../shared/model/style.js'
import { buildToc, tocEntryLabel, type TocEntry } from '../../shared/pm/toc.js'

/**
 * `nav.xhtml` (EPUB 3's own navigation document) and a matching `toc.ncx`
 * (for readers that still want the EPUB 2 shape).
 *
 * `buildToc` — the same pure function that drives the in-app contents panel
 * and DOCX headings — decides what counts as a heading here too. A second
 * implementation would disagree with it the first time somebody nested a
 * style's outline level, and the one that disagrees silently is the file the
 * reader navigates by.
 */

export interface NavChapter {
  href: string
  title: string
  doc: PmDoc
}

interface NavEntry {
  href: string
  label: string
  level: number
  children: NavEntry[]
}

function chapterEntries(chapter: NavChapter, styles: NamedStyle[]): NavEntry[] {
  const toc: TocEntry[] = buildToc(chapter.doc, styles)
  if (toc.length === 0) return [{ href: chapter.href, label: chapter.title, level: 1, children: [] }]
  return toc.map((entry) => ({
    href: entry.blockId ? `${chapter.href}#${entry.blockId}` : chapter.href,
    label: tocEntryLabel(entry),
    level: entry.level,
    children: []
  }))
}

function renderList(entries: NavEntry[]): string {
  const items = entries.map((entry) => `<li><a href="${entry.href}">${escapeXml(entry.label)}</a></li>`)
  return `<ol>\n${items.join('\n')}\n</ol>`
}

export function buildNavXhtml(chapters: NavChapter[], styles: NamedStyle[], landmarkHref?: string): string {
  const entries = chapters.flatMap((chapter) => chapterEntries(chapter, styles))
  const landmarks = landmarkHref
    ? `<nav epub:type="landmarks" hidden="">\n<ol>\n<li><a epub:type="cover" href="${landmarkHref}">Cover</a></li>\n</ol>\n</nav>`
    : ''
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body>
<nav epub:type="toc" id="toc">
<h1>Contents</h1>
${renderList(entries)}
</nav>
${landmarks}
</body>
</html>
`
}

export function buildNcx(chapters: NavChapter[], styles: NamedStyle[], bookId: string, title: string): string {
  const entries = chapters.flatMap((chapter) => chapterEntries(chapter, styles))
  let playOrder = 1
  const points = entries
    .map(
      (entry) => `<navPoint id="np-${playOrder}" playOrder="${playOrder++}">
  <navLabel><text>${escapeXml(entry.label)}</text></navLabel>
  <content src="${entry.href}"/>
</navPoint>`
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:${bookId}"/>
  </head>
  <docTitle><text>${escapeXml(title)}</text></docTitle>
  <navMap>
${points}
  </navMap>
</ncx>
`
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
