import { z } from 'zod'
import { buildScopeSchema } from '../settings/registry.js'
import { keybindingOverridesSchema } from '../menu/keybindings.js'
import { authorProfileSchema } from './author.js'

export const recentProjectSchema = z.object({
  uri: z.string(),
  name: z.string(),
  opened: z.string()
})
export type RecentProject = z.infer<typeof recentProjectSchema>

/**
 * The preferences half of app state, derived from the settings registry.
 *
 * Kept beside the theme rather than in the dock layout, which is dockview's own
 * opaque blob, because these are the same kind of thing — small preferences
 * belonging to the person, shared across every window, outliving any one
 * project. The stored property names are unchanged; see
 * `shared/settings/registry.ts` for what each one is.
 */
const appSettingsSchema = buildScopeSchema('app')

/** Cross-window state owned by the main process and pushed to every renderer. */
export const appStateSchema = z.object({
  version: z.string(),
  platform: z.string(),
  recentProjects: z.array(recentProjectSchema).default([]),
  /**
   * Accelerators the person has changed, keyed by command id. Only overrides
   * live here — a command left alone is absent, so a later change to a default
   * shortcut reaches everyone who never rebound it.
   */
  keybindings: keybindingOverridesSchema.default({}),
  /**
   * Who this person is when they comment or suggest.
   *
   * App-scoped, in userData: an identity belongs to the person and their
   * machine, not to a manuscript — and a project folder that carries its
   * reviewers' identities would hand them to anyone the folder is shared with.
   * The id is minted once and never changes.
   */
  author: authorProfileSchema.prefault({ id: '', name: '', color: '' }),
  ...appSettingsSchema.shape
})
export type AppState = z.infer<typeof appStateSchema>
export type TimelineOrientation = AppState['timelineOrientation']
