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
  theme: z
    .enum([
      'dark',
      'light',
      'blue',
      'dark-purple',
      'edinburgh-cafe',
      'gloomy-castle',
      'gritty-philadelphia',
      'hokkaido',
      'ocean',
      'red',
      'scottish-highlands',
      'tokyo'
    ])
    .default('dark'),
  /**
   * Which way the timeline runs.
   *
   * Horizontal by default: a chronology reads left to right, and laid that way
   * it sits comfortably in a short, wide panel under the manuscript rather than
   * demanding a tall column beside it.
   *
   * Kept here beside the theme rather than in the dock layout, which is
   * dockview's own opaque blob, because this is the same kind of thing — one
   * small preference belonging to the person, shared across every window,
   * outliving any one project.
   */
  timelineOrientation: z.enum(['horizontal', 'vertical']).default('horizontal')
})
export type AppState = z.infer<typeof appStateSchema>
export type TimelineOrientation = AppState['timelineOrientation']
