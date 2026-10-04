export interface CleanedPaste {
  html: string
  /** Inline `data:` images the schema will refuse (`Image` runs with `allowBase64: false`). */
  droppedImages: number
}

/**
 * Strip what Word and Google Docs put on the clipboard besides the writing:
 * conditional comments (VML fallbacks that otherwise surface as stray text),
 * Office `<o:p>` paragraph placeholders, and `mso-*` style declarations that
 * the editor's own style parsers would read as direct formatting.
 */
export function cleanPastedHtml(html: string): CleanedPaste {
  const droppedImages = (html.match(/<img\b[^>]*\bsrc\s*=\s*["']?data:/gi) ?? []).length
  const cleaned = html
    .replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, '')
    .replace(/<!\[if[^\]]*\]>|<!\[endif\]>/gi, '')
    .replace(/<\/?o:p\b[^>]*>/gi, '')
    .replace(/\sstyle\s*=\s*(["'])([\s\S]*?)\1/gi, (_match, quote: string, style: string) => {
      const kept = style
        .split(';')
        .map((declaration) => declaration.trim())
        .filter((declaration) => declaration && !/^mso-/i.test(declaration))
        .join('; ')
      return kept ? ` style=${quote}${kept}${quote}` : ''
    })
  return { html: cleaned, droppedImages }
}
