import { z } from 'zod'
import { FORMAT_VERSIONS } from '../constants.js'
import { pmDocSchema, EMPTY_DOC } from './document.js'

/**
 * Every kind of record shares one schema, one service and one panel —
 * parameterised by `kind` — rather than a implementation per kind that would
 * drift apart. `kind` is a plain string, not a compile-time enum: which kinds
 * a project offers (a thesis wants interviewees and concepts; fiction wants
 * characters and locations) is project data, on the manifest's `entityKinds`
 * (`model/manifest.ts`), not something this build's schema can enumerate.
 */
export const entityKinds = ['character', 'location'] as const
export const entityKindSchema = z.string()
export type EntityKind = z.infer<typeof entityKindSchema>

/** One kind of record a project offers, and how the UI should talk about it. */
export const entityKindDefSchema = z.object({
  id: z.string(),
  /** "character" — used in "New character". */
  label: z.string(),
  /** "Characters" — the panel title and empty-state heading. */
  labelPlural: z.string(),
  suggestedFields: z.array(z.string()).optional()
})
export type EntityKindDef = z.infer<typeof entityKindDefSchema>

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
  /**
   * Written by the assistant and not yet accepted by a person.
   *
   * The record is real — it has an id, it is in the file, mentions resolve to
   * it, the storyboard can cast it — but it is visibly the model's guess.
   * Accepting clears the flag; that is the only thing accepting does.
   *
   * It is also the safety boundary: a tool may revise a record while this is
   * set and never once it is clear, so a character the writer spent an
   * afternoon on cannot be "helpfully tidied" by a model.
   */
  provisional: z.boolean().default(false),
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

/**
 * Field labels offered when adding a detail, by kind. Suggestions, not
 * schema. Looked up leniently elsewhere (an unknown kind suggests no fields
 * rather than throwing), since a project's configured kinds are no longer
 * limited to the two below.
 */
export const SUGGESTED_FIELDS: Record<string, string[]> = {
  character: ['Age', 'Role', 'Occupation', 'Appearance', 'Voice', 'Wants', 'Fears', 'Arc'],
  location: ['Region', 'Type', 'Population', 'Climate', 'Atmosphere', 'History', 'Ruled by']
}

/** The record kinds a project offers when its manifest doesn't say otherwise — every project made before Phase 6. */
export const DEFAULT_ENTITY_KINDS: EntityKindDef[] = [
  { id: 'character', label: 'character', labelPlural: 'Characters', suggestedFields: SUGGESTED_FIELDS.character },
  { id: 'location', label: 'location', labelPlural: 'Locations', suggestedFields: SUGGESTED_FIELDS.location }
]

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
