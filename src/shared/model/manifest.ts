import { z } from 'zod'
import { FORMAT_VERSIONS, AUTOSAVE_DEBOUNCE_MS, AUTOSAVE_MAX_WAIT_MS } from '../constants.js'
import { namedStyleSchema, BUILTIN_STYLES } from './style.js'
import { entityKindDefSchema } from './entity.js'

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
  defaultStyleId: z.string().default('body'),
  /**
   * A `citeproc-plus` style id — `chicago-author-date`, `chicago-notes-
   * bibliography`, `apa`, `modern-language-association`, or any of the
   * ~2000 others the engine bundles. A plain string rather than an enum for
   * the same reason `cslItemSchema.type` is: the four this build's picker
   * offers by name are not the only ones a project may want.
   */
  citationStyleId: z.string().default('chicago-author-date')
})
export type ProjectSettings = z.infer<typeof projectSettingsSchema>

/**
 * What kind of thing this project is, which is a question only the *shell*
 * asks: which panels to offer, which template produced it, which vocabulary
 * its records use. Nothing in the editor, the VFS or the export path branches
 * on it, and nothing should start to — a project type that reached into
 * document behaviour would be a second, weaker styles system.
 */
export const projectTypes = ['novel', 'thesis', 'essay', 'research-paper', 'screenplay'] as const
export const projectTypeSchema = z.enum(projectTypes)
export type ProjectType = z.infer<typeof projectTypeSchema>

export const projectManifestSchema = z.object({
  formatVersion: z.number().int().default(FORMAT_VERSIONS.manifest),
  id: z.string(),
  name: z.string(),
  created: z.string(),
  modified: z.string(),
  /** Every project made before templates existed is a novel. */
  projectType: projectTypeSchema.default('novel'),
  // `prefault` (not `default`) so an absent or partial settings block still gets
  // each field's own default filled in rather than requiring the whole object.
  settings: projectSettingsSchema.prefault({}),
  /** Project-wide named styles shared by every document. */
  styles: z.array(namedStyleSchema).default(BUILTIN_STYLES),
  /**
   * The record kinds this project offers — a thesis wants interviewees and
   * concepts, fiction wants characters and locations. Absent means the
   * fiction defaults (`DEFAULT_ENTITY_KINDS`), so every project made before
   * this field existed is unaffected.
   */
  entityKinds: z.array(entityKindDefSchema).optional()
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
  /**
   * Whether the project is a folder on this machine.
   *
   * The renderer needs it to know which of the operating system's ideas apply:
   * a file on a server has no folder to reveal and no trash to be moved to, so
   * offering either is offering something that cannot work. Main refuses those
   * itself as well — this is what stops them being offered in the first place.
   */
  isLocal: z.boolean(),
  manifest: projectManifestSchema,
  /**
   * The manifest on disk was written by a newer version of The Pub than this
   * one. The project still opens — refusing outright would strand someone who
   * only wants to read — but nothing may write back, since this build's
   * schema cannot be trusted to round-trip a shape it doesn't fully know.
   */
  readOnly: z.boolean().default(false)
})
export type OpenProject = z.infer<typeof openProjectSchema>
