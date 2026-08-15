import { z } from 'zod'
import { FORMAT_VERSION, AUTOSAVE_DEBOUNCE_MS, AUTOSAVE_MAX_WAIT_MS } from '../constants.js'
import { namedStyleSchema, BUILTIN_STYLES } from './style.js'

export const projectSettingsSchema = z.object({
  autosaveDebounceMs: z.number().int().min(100).max(30_000).default(AUTOSAVE_DEBOUNCE_MS),
  autosaveMaxWaitMs: z.number().int().min(500).max(120_000).default(AUTOSAVE_MAX_WAIT_MS),
  snapshotsEnabled: z.boolean().default(true),
  /** Editor "sheet" width in points. Not true pagination — a readable measure. */
  pageWidth: z.number().default(612),
  /**
   * Page height in points. The editor scrolls continuously and never uses it,
   * but an exported `.docx` has to state a paper size, and inventing one at
   * export time would mean the same manuscript exported differently depending
   * on which code path ran. 612×792 is US Letter; A4 is 595×842.
   */
  pageHeight: z.number().default(792),
  pageMargin: z.number().default(72),
  defaultStyleId: z.string().default('body')
})
export type ProjectSettings = z.infer<typeof projectSettingsSchema>

export const projectManifestSchema = z.object({
  formatVersion: z.number().int().default(FORMAT_VERSION),
  id: z.string(),
  name: z.string(),
  created: z.string(),
  modified: z.string(),
  // `prefault` (not `default`) so an absent or partial settings block still gets
  // each field's own default filled in rather than requiring the whole object.
  settings: projectSettingsSchema.prefault({}),
  /** Project-wide named styles shared by every document. */
  styles: z.array(namedStyleSchema).default(BUILTIN_STYLES)
})
export type ProjectManifest = z.infer<typeof projectManifestSchema>

/** A manifest plus the location it was loaded from. */
export const openProjectSchema = z.object({
  /** Absolute filesystem path (local backend) or backend URI. */
  uri: z.string(),
  root: z.string(),
  /**
   * The opaque name asset URLs know this project by, so the renderer can turn
   * a stored project-relative image path into a displayable URL synchronously
   * — a stored map background would otherwise cost an IPC round trip per image.
   */
  assetToken: z.string(),
  manifest: projectManifestSchema
})
export type OpenProject = z.infer<typeof openProjectSchema>
