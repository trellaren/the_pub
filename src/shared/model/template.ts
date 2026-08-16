import { z } from 'zod'
import { projectTypeSchema } from './manifest.js'

/**
 * A project template is a project folder, serialised — `.thepub/project.json`
 * and whatever else its author chose to include, laid out exactly as a real
 * project is. There is no template format to keep in step with the project
 * format, because there is no second format: a template directory can be
 * opened as a project, which is also how you edit one.
 *
 * The only thing a template has that a project does not is `template.json` at
 * its root, holding the handful of facts the picker needs before anything is
 * instantiated.
 */
export const templateManifestSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().default(''),
  projectType: projectTypeSchema
})
export type TemplateManifest = z.infer<typeof templateManifestSchema>

/**
 * Where a template came from. Built-ins ship with the app and cannot be
 * deleted; user templates live in `userData` and can.
 */
export const templateSourceSchema = z.enum(['builtin', 'user'])
export type TemplateSource = z.infer<typeof templateSourceSchema>

export const templateSummarySchema = templateManifestSchema.extend({
  source: templateSourceSchema,
  /** Documents the template seeds, for the picker to show before committing. */
  documentCount: z.number().int().min(0).default(0)
})
export type TemplateSummary = z.infer<typeof templateSummarySchema>

/**
 * What "Save Project as Template…" carries across.
 *
 * Styles and settings always travel — they are what makes a template a
 * template. Everything else is opt-in, and defaults to *off*: a template that
 * quietly contains someone's draft chapter three is a worse failure than one
 * that turns out to be missing a file they wanted.
 */
export const saveTemplateOptionsSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  projectType: projectTypeSchema,
  include: z
    .object({
      entities: z.boolean().default(false),
      beats: z.boolean().default(false),
      maps: z.boolean().default(false),
      manuscript: z.boolean().default(false),
      layout: z.boolean().default(false),
      /** Project-relative `.pubdoc` paths, chosen one by one. */
      documents: z.array(z.string()).default([])
    })
    .prefault({})
})
export type SaveTemplateOptions = z.infer<typeof saveTemplateOptionsSchema>
