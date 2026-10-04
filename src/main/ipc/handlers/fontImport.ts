import path from 'node:path'
import fs from 'node:fs/promises'
import { ulid } from 'ulid'
import type { ProjectSession } from '../../services/projectSession.js'
import { FONTS_DIR } from '../../../shared/constants.js'
import { FONT_EXTENSIONS } from '../../../shared/model/asset.js'
import type { ProjectFont } from '../../../shared/model/manifest.js'

/**
 * Copy one font file into `.thepub/fonts/` through the project's adapter,
 * so it lands on remote projects too. The manifest entry is returned, not
 * written: `manifest.fonts` is saved by the renderer through
 * `project:updateManifest`, the same division `templates:applyPreset` draws.
 */
export async function importFontFile(session: ProjectSession, file: string): Promise<{ font: ProjectFont }> {
  const extension = path.extname(file).slice(1).toLowerCase()
  if (!(FONT_EXTENSIONS as readonly string[]).includes(extension)) {
    throw new Error('Only .ttf, .otf, .woff and .woff2 fonts can be imported.')
  }
  const bytes = await fs.readFile(file)
  // Whole CJK families run to tens of megabytes; a "font" beyond that is a
  // mistake, and it would be copied to every machine the project opens on.
  if (bytes.length > 64 * 1024 * 1024) throw new Error('That file is too large to be a font.')

  const id = ulid()
  const relative = `${FONTS_DIR}/${id}.${extension}`
  await session.adapter.mkdir(FONTS_DIR).catch(() => {})
  await session.adapter.writeFileAtomic(relative, bytes)

  // The filename, cleaned, is the family name. Reading the real one out of
  // the binary would mean carrying a font parser for a single string; the
  // filename is nearly always the family anyway, and it is visible before
  // the import, so a surprise here is at least not a mystery.
  const family =
    path
      .basename(file, path.extname(file))
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'Imported font'
  return { font: { id, family, file: relative } }
}
