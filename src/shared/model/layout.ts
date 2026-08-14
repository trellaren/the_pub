import { z } from 'zod'
import { FORMAT_VERSION } from '../constants.js'

/**
 * Dockview's serialized layout. Treated as an opaque blob — dockview owns the
 * shape (including nested `popoutGroups`), and pinning it here would break every
 * time dockview evolves its format.
 */
export const dockLayoutSchema = z.record(z.string(), z.unknown())
export type DockLayout = z.infer<typeof dockLayoutSchema>

export const layoutPresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  created: z.string(),
  layout: dockLayoutSchema
})
export type LayoutPreset = z.infer<typeof layoutPresetSchema>

export const layoutFileSchema = z.object({
  formatVersion: z.number().int().default(FORMAT_VERSION),
  /** Restored automatically when the project is reopened. */
  lastLayout: dockLayoutSchema.nullable().default(null),
  presets: z.array(layoutPresetSchema).default([])
})
export type LayoutFile = z.infer<typeof layoutFileSchema>
