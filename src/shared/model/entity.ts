import { z } from 'zod'
import { FORMAT_VERSIONS } from '../constants.js'
import { pmDocSchema, EMPTY_DOC } from './document.js'

/**
 * Characters and locations are the same shape of record and differ only in
 * which field labels the UI suggests, so they share one schema, one service
 * and one panel rather than two implementations that drift apart.
 */
export const entityKinds = ['character', 'location'] as const
export const entityKindSchema = z.enum(entityKinds)
export type EntityKind = z.infer<typeof entityKindSchema>

/**
 * An alternative name the record answers to.
 *
 * `scan` is per-alias because an over-common form ("Rose", "the Doctor") needs
 * to be excluded from name scanning without being deleted — it is still the
 * right thing to show on the record and to offer in @-autocomplete.
 */
export const entityAliasSchema = z.object({
  text: z.string(),
  scan: z.boolean().default(true)
})
export type EntityAlias = z.infer<typeof entityAliasSchema>

/**
 * A user-defined detail: "Age", "Occupation", "Ruled by".
 *
 * Kinds carry no bespoke columns. A grab-bag of optional per-kind fields would
 * be wrong within a week of real use, and every story wants different ones.
 */
export const entityFieldSchema = z.object({
  label: z.string(),
  value: z.string().default('')
})
export type EntityField = z.infer<typeof entityFieldSchema>

/** A typed edge to another record: "brother of", "lives in". */
export const entityRelationSchema = z.object({
  targetId: z.string(),
  label: z.string().default('')
})
export type EntityRelation = z.infer<typeof entityRelationSchema>

export const storyEntitySchema = z.object({
  id: z.string(),
  kind: entityKindSchema,
  name: z.string(),
  // `() => []` and not `[]`: zod hands back the *same* array reference on every
  // parse of a literal default, and the renderer mutates these.
  aliases: z.array(entityAliasSchema).default(() => []),
  /** Highlight colour for mentions of this record. */
  color: z.string().optional(),
  summary: z.string().default(''),
  /**
   * Long-form notes as a ProseMirror document. This is the reason records live
   * outside project.json — putting a whole document in the manifest would
   * rewrite every named style on each keystroke.
   */
  notes: pmDocSchema.default(() => structuredClone(EMPTY_DOC)),
  fields: z.array(entityFieldSchema).default(() => []),
  relations: z.array(entityRelationSchema).default(() => []),
  /** Whole-record switch for name scanning; individual aliases have their own. */
  scan: z.boolean().default(true),
  created: z.string(),
  modified: z.string()
})
export type StoryEntity = z.infer<typeof storyEntitySchema>

/**
 * A suggestion the author has explicitly silenced.
 *
 * Keyed by surface rather than by offset so it survives editing around it —
 * an occurrence's position moves with every keystroke earlier in the block.
 * Without a way to kill a false positive, users switch scanning off entirely.
 */
export const dismissedMentionSchema = z.object({
  entityId: z.string(),
  docId: z.string(),
  surface: z.string()
})
export type DismissedMention = z.infer<typeof dismissedMentionSchema>

/**
 * The whole `.thepub/entities.json` file.
 *
 * One file for both kinds, not a file per kind: the write-amplification reason
 * for splitting records out of the manifest does not distinguish characters
 * from locations, and one file lets a character reference a location without a
 * cross-file join.
 */
export const entityFileSchema = z.object({
  formatVersion: z.number().int().default(FORMAT_VERSIONS.entities),
  entities: z.array(storyEntitySchema).default(() => []),
  dismissed: z.array(dismissedMentionSchema).default(() => [])
})
export type EntityFile = z.infer<typeof entityFileSchema>

export const EMPTY_ENTITY_FILE: EntityFile = {
  formatVersion: FORMAT_VERSIONS.entities,
  entities: [],
  dismissed: []
}

/** Field labels offered when adding a detail, by kind. Suggestions, not schema. */
export const SUGGESTED_FIELDS: Record<EntityKind, string[]> = {
  character: ['Age', 'Role', 'Occupation', 'Appearance', 'Voice', 'Wants', 'Fears', 'Arc'],
  location: ['Region', 'Type', 'Population', 'Climate', 'Atmosphere', 'History', 'Ruled by']
}

/**
 * Mention highlight palette. Assigned round-robin to new records so a project
 * is legible before anyone opens a colour picker.
 */
export const ENTITY_COLORS = [
  '#7aa2f7',
  '#9ece6a',
  '#e0af68',
  '#bb9af7',
  '#f7768e',
  '#7dcfff',
  '#c0caf5',
  '#ff9e64'
]

export function colorForIndex(index: number): string {
  return ENTITY_COLORS[index % ENTITY_COLORS.length]
}
