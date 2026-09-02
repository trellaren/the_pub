import type { ProjectFont } from '@shared/model/manifest.js'
import { buildAssetUrl } from '@shared/model/asset.js'

/**
 * The `@font-face` rules for a project's imported fonts.
 *
 * A stylesheet rather than `FontFace` objects on purpose: `document.fonts` is
 * per-window, and a face added there imperatively would have to be re-added to
 * every popout as it opens. A `<style>` element rides the exact machinery the
 * named-style sheet already uses (`registerDocumentEffect`), so a popped-out
 * editor gets the project's fonts the same way it gets its styles.
 */
export function generateFontFaceSheet(fonts: ProjectFont[], assetToken: string): string {
  return fonts
    .map(
      (font) =>
        `@font-face { font-family: ${quoteFamily(font.family)}; src: url("${buildAssetUrl(
          assetToken,
          font.file
        )}"); }`
    )
    .join('\n')
}

/**
 * A family name in a CSS string context. Imported names come from filenames,
 * which can carry quotes and backslashes; a name that breaks out of its own
 * quoting would let a filename write arbitrary CSS into every window.
 */
function quoteFamily(family: string): string {
  return `"${family.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, ' ')}"`
}
