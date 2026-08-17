import { z } from 'zod'
import type { ProjectManifest } from './manifest.js'

/**
 * The one discriminator every output format shares, for `publish:export` /
 * `publish:exportDialog` — see `docs/phase-12-plan.md` Part 5. `docx` and
 * `fountain` existed as their own channels first; this list is a superset,
 * not a replacement, so old and new channels stay in agreement about what a
 * "format" is.
 */
export const publishFormatSchema = z.enum(['docx', 'fountain', 'epub', 'pdf', 'print'])
export type PublishFormat = z.infer<typeof publishFormatSchema>

/**
 * What a format cannot carry from the project as it stands — the export-side
 * counterpart of `docxImportResultSchema.warnings`. Pure and manifest-only so
 * it can run before any file is touched, in the export dialog, the same
 * moment `docxImportResultSchema` reports its warnings after the fact.
 */
export function exportWarnings(format: PublishFormat, manifest: ProjectManifest): string[] {
  const warnings: string[] = []
  switch (format) {
    case 'epub':
      warnings.push(
        'EPUB has no fixed page numbers — a page cross-reference degrades to a link to the referenced spot.'
      )
      if (!manifest.publication.coverImagePath) {
        warnings.push('No cover image is set — the EPUB will have no cover.')
      }
      break
    case 'pdf':
    case 'print':
      warnings.push(
        'A paginated PDF cannot reflow — page breaks are fixed at the project\'s current page size and margins.'
      )
      break
    case 'fountain':
      warnings.push(
        'Fountain carries plain screenplay text only — styles, footnotes, images, tables and comments are not exported.'
      )
      break
    case 'docx':
      break
  }
  return warnings
}
