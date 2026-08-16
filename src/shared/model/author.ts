import { z } from 'zod'
import { FORMAT_VERSIONS } from '../constants.js'

/**
 * Who is writing.
 *
 * No accounts, no server, no verification. The trust model is a writing group
 * or a supervisor — the same people you would email the manuscript to — and an
 * identity system stronger than that would be theatre: anyone who can write to
 * the project folder can write anything into it regardless.
 *
 * The id is generated once on this machine and never changes. Everything this
 * phase writes is stamped with the **id**, never the name, so renaming yourself
 * renames you everywhere at once — the same ids-over-copies rule records
 * already follow.
 */
export const authorProfileSchema = z.object({
  id: z.string(),
  name: z.string().default(''),
  /**
   * How this author's suggestions and comments are tinted.
   *
   * Chosen from a fixed palette rather than a colour picker: these have to stay
   * legible against both themes and distinguishable from each other, and a
   * free-form colour cannot promise either.
   */
  color: z.string().default('')
})
export type AuthorProfile = z.infer<typeof authorProfileSchema>

/**
 * The colours an author can be.
 *
 * Eight, spaced around the wheel, all readable on both the light and the dark
 * surface. Assigned by hashing the author id so two people who have never met
 * usually differ, and changeable by hand when they collide.
 */
export const AUTHOR_COLORS = [
  '#c2410c',
  '#0369a1',
  '#15803d',
  '#7e22ce',
  '#b91c1c',
  '#0f766e',
  '#a16207',
  '#be185d'
] as const

/** A stable colour for an id, so an author looks the same before they pick one. */
export function colorForAuthor(authorId: string): string {
  let hash = 0
  for (const character of authorId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  return AUTHOR_COLORS[hash % AUTHOR_COLORS.length]!
}

/**
 * The id to use for someone who exists only as a Word tracked-change author.
 *
 * Derived from the name rather than generated, and so stable: importing the
 * same file twice, or two chapters a reviewer marked up separately, produces
 * one author rather than one per import. The prefix keeps them visibly distinct
 * from ids minted on a real machine — a name is a weak identity, and two
 * different people called "M. Whiteside" would collide here.
 */
export function importedAuthorId(name: string): string {
  let hash = 0
  for (const character of name.trim().toLowerCase()) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  }
  return `docx-${hash.toString(36)}`
}

/**
 * The project's registry of everyone who has touched it.
 *
 * Display metadata, not truth: it exists so a comment renders "Marta", in her
 * colour, while Marta is offline. Last-writer-wins per entry is fine for the
 * same reason — the worst case is a stale display name.
 */
export const authorsFileSchema = z.object({
  formatVersion: z.number().int().default(FORMAT_VERSIONS.authors),
  authors: z.array(authorProfileSchema).default(() => [])
})
export type AuthorsFile = z.infer<typeof authorsFileSchema>

export const EMPTY_AUTHORS_FILE: AuthorsFile = {
  formatVersion: FORMAT_VERSIONS.authors,
  authors: []
}

/** What to show for an author who is not in the registry. */
export function describeAuthor(authorId: string, authors: readonly AuthorProfile[]): AuthorProfile {
  const known = authors.find((author) => author.id === authorId)
  if (known) return { ...known, color: known.color || colorForAuthor(authorId) }
  // Not "Unknown": an id is at least *an* answer, and a reviewer who never
  // filled in a name is far more likely than a corrupted file.
  return { id: authorId, name: `Author ${authorId.slice(-4)}`, color: colorForAuthor(authorId) }
}
