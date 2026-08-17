import type { PmDoc } from '../../shared/model/document.js'
import type { PageSetup } from '../../shared/model/document.js'
import type { NamedStyle } from '../../shared/model/style.js'
import { documentToXhtml } from '../epub/xhtml.js'
import { buildStylesheet } from '../epub/css.js'

export interface PrintDocument {
  title: string
  content: PmDoc
}

export interface PrintImage {
  data: Uint8Array
  extension: string
}

/**
 * `ExportItem[]`-shaped documents → one self-contained HTML page, reusing the
 * EPUB writer (`documentToXhtml`/`buildStylesheet`) rather than a second
 * ProseMirror-to-markup implementation. The page carries its own `@page`
 * rule sized from `setup` — `printOptions.ts` sets `preferCSSPageSize` so
 * `printToPDF` honours it instead of scaling to a standard paper size.
 *
 * Images are inlined as `data:` URIs, keyed by basename the same way
 * `imageHref` names them, so the offscreen window needs no second HTTP round
 * trip to fetch project assets.
 */
export function buildPrintHtml(
  documents: PrintDocument[],
  styles: NamedStyle[],
  setup: PageSetup,
  images: Map<string, PrintImage>
): string {
  const width = setup.orientation === 'landscape' ? setup.height : setup.width
  const height = setup.orientation === 'landscape' ? setup.width : setup.height

  const sections = documents.map((document, index) => {
    const { body } = documentToXhtml(document.content, styles, `d${index}`)
    return `<section class="pub-doc"${index > 0 ? ' style="break-before: page;"' : ''}>\n${body}\n</section>`
  })

  const css = `${buildStylesheet(styles)}
@page { size: ${width}pt ${height}pt; margin: ${setup.margin}pt; }
body { margin: 0; }
.pub-doc { break-inside: auto; }
img { max-width: 100%; }`

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(documents[0]?.title ?? 'Print')}</title>
<style>${css}</style>
</head>
<body>
${sections.join('\n')}
</body>
</html>`

  return rewriteImageSrcs(html, images)
}

function rewriteImageSrcs(html: string, images: Map<string, PrintImage>): string {
  return html.replace(/src="([^"]*)"/g, (match, src: string) => {
    const name = src.startsWith('../images/') ? src.slice('../images/'.length) : null
    if (!name) return match
    const image = images.get(name)
    if (!image) return match
    const mime = mimeFor(image.extension)
    const base64 = Buffer.from(image.data).toString('base64')
    return `src="data:${mime};base64,${base64}"`
  })
}

function mimeFor(extension: string): string {
  switch (extension.toLowerCase()) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    case 'svg':
      return 'image/svg+xml'
    default:
      return 'image/png'
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
