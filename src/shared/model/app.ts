import { z } from 'zod'

export const recentProjectSchema = z.object({
  uri: z.string(),
  name: z.string(),
  opened: z.string()
})
export type RecentProject = z.infer<typeof recentProjectSchema>

/** Cross-window state owned by the main process and pushed to every renderer. */
export const appStateSchema = z.object({
  version: z.string(),
  platform: z.string(),
  recentProjects: z.array(recentProjectSchema).default([]),
  theme: z.enum(['dark', 'light']).default('dark')
})
export type AppState = z.infer<typeof appStateSchema>
