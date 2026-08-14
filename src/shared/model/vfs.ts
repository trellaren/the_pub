import { z } from 'zod'

export const vfsEntrySchema = z.object({
  name: z.string(),
  /** Project-relative, POSIX-separated. `''` is the project root. */
  path: z.string(),
  kind: z.enum(['file', 'dir']),
  size: z.number().optional(),
  mtime: z.number().optional()
})
export type VfsEntry = z.infer<typeof vfsEntrySchema>

export const fileChangeEventSchema = z.object({
  type: z.enum(['add', 'change', 'unlink', 'addDir', 'unlinkDir']),
  path: z.string(),
  mtime: z.number().optional()
})
export type FileChangeEvent = z.infer<typeof fileChangeEventSchema>

/**
 * What a backend can do natively. Consumers never branch on these — the registry
 * emulates the missing behaviour (e.g. polling when `watch` is false) — but the
 * flags let it choose the right emulation.
 */
export const vfsCapabilitiesSchema = z.object({
  watch: z.boolean(),
  atomicRename: z.boolean(),
  caseSensitive: z.boolean(),
  preservesMtime: z.boolean(),
  fastStat: z.boolean()
})
export type VfsCapabilities = z.infer<typeof vfsCapabilitiesSchema>
