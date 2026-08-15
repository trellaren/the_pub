import type { NamedStyle } from '../../shared/model/style.js'
import { STYLE_BODY } from '../../shared/model/style.js'

/**
 * Word style names ↔ The Pub's style ids.
 *
 * Both applications have the same idea — a named bundle of formatting that a
 * paragraph refers to rather than copies — so the mapping is mostly a matter of
 * agreeing on spelling. Where a Word style has an obvious counterpart among the
 * built-ins it maps onto it, because an imported "Heading 1" that becomes a
 * bespoke style called "Heading 1" would look right and behave wrong: editing
 * the project's Heading 1 afterwards would leave the imported chapters alone.
 */

/** Word style name (lower-cased, spaces stripped) → built-in Pub style id. */
const WORD_TO_PUB: Record<string, string> = {
  normal: STYLE_BODY,
  bodytext: STYLE_BODY,
  default: STYLE_BODY,
  plaintext: STYLE_BODY,
  // Word puts this on every list item. It carries no formatting of its own that
  // matters here — the list node supplies its own indent — so treating it as
  // body text keeps it from being added to the project as a bespoke style.
  listparagraph: STYLE_BODY,
  firstparagraph: 'first-paragraph',
  bodytextfirstindent: 'first-paragraph',
  bodytextindent: 'indented-body',
  heading1: 'heading-1',
  heading2: 'heading-2',
  heading3: 'heading-3',
  heading4: 'heading-4',
  heading5: 'heading-5',
  heading6: 'heading-6',
  title: 'chapter-title',
  subtitle: 'heading-2',
  quote: 'block-quote',
  intensequote: 'block-quote',
  blockquote: 'block-quote',
  blocktext: 'block-quote'
}

/** Pub style id → the Word style id and name to emit for it. */
const PUB_TO_WORD: Record<string, { id: string; name: string }> = {
  [STYLE_BODY]: { id: 'Normal', name: 'Normal' },
  'first-paragraph': { id: 'FirstParagraph', name: 'First Paragraph' },
  'indented-body': { id: 'BodyTextIndent', name: 'Body Text Indent' },
  'heading-1': { id: 'Heading1', name: 'heading 1' },
  'heading-2': { id: 'Heading2', name: 'heading 2' },
  'heading-3': { id: 'Heading3', name: 'heading 3' },
  'heading-4': { id: 'Heading4', name: 'heading 4' },
  'heading-5': { id: 'Heading5', name: 'heading 5' },
  'heading-6': { id: 'Heading6', name: 'heading 6' },
  'chapter-title': { id: 'Title', name: 'Title' },
  'scene-break': { id: 'SceneBreak', name: 'Scene Break' },
  'block-quote': { id: 'Quote', name: 'Quote' }
}

/**
 * Word writes `w:styleId="Heading1"` but displays "heading 1", and different
 * producers disagree about capitalisation and spacing. Comparing on a squashed
 * form means "Heading 1", "heading1" and "HEADING  1" all land in one place.
 */
export function normalizeStyleKey(name: string): string {
  return name.toLowerCase().replace(/[\s_-]+/g, '')
}

/** The built-in this Word style corresponds to, or null if it has no counterpart. */
export function builtinForWordStyle(nameOrId: string): string | null {
  return WORD_TO_PUB[normalizeStyleKey(nameOrId)] ?? null
}

/** What to call a Pub style in the exported file. */
export function wordStyleFor(styleId: string, name: string): { id: string; name: string } {
  const known = PUB_TO_WORD[styleId]
  if (known) return known
  // A user-created style keeps its own name; the id has to be XML-name-safe.
  return { id: slugToWordId(styleId), name }
}

function slugToWordId(styleId: string): string {
  const cleaned = styleId.replace(/[^a-zA-Z0-9]/g, '')
  return cleaned.length > 0 ? cleaned : 'CustomStyle'
}

/**
 * Turn a Word style name into a Pub style id.
 *
 * Deliberately *not* `style-${Date.now().toString(36)}`, the convention the
 * styles panel uses for a hand-made style: importing a document mints a dozen
 * ids inside the same millisecond, and that scheme collides. A slug of the name
 * is also readable in the saved JSON, which matters when a document's styleId
 * is the only clue to why a paragraph looks the way it does.
 */
export function styleIdForName(name: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'imported-style'
  if (!used.has(base)) return base
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!used.has(candidate)) return candidate
  }
  // Unreachable in practice; a stable fall-back beats an infinite loop.
  return `${base}-${used.size}`
}

/**
 * Reconcile the styles a document arrived with against the project's own.
 *
 * Returns the id each incoming Word style should use, plus only those styles
 * that genuinely need adding. Anything matching a built-in resolves to it, and
 * anything matching a project style *by name* reuses that one — so importing
 * three chapters of the same book does not produce "Epigraph", "Epigraph-2" and
 * "Epigraph-3".
 */
export function reconcileStyles(
  incoming: NamedStyle[],
  existing: NamedStyle[]
): { mapping: Map<string, string>; added: NamedStyle[] } {
  const mapping = new Map<string, string>()
  const added: NamedStyle[] = []
  const taken = new Set(existing.map((style) => style.id))
  const byName = new Map(existing.map((style) => [normalizeStyleKey(style.name), style.id]))

  for (const style of incoming) {
    const builtin = builtinForWordStyle(style.name) ?? builtinForWordStyle(style.id)
    if (builtin && taken.has(builtin)) {
      mapping.set(style.id, builtin)
      continue
    }
    const sameName = byName.get(normalizeStyleKey(style.name))
    if (sameName) {
      mapping.set(style.id, sameName)
      continue
    }
    const id = styleIdForName(style.name, taken)
    taken.add(id)
    byName.set(normalizeStyleKey(style.name), id)
    mapping.set(style.id, id)
    added.push({ ...style, id, builtin: false })
  }

  // `basedOn` and `nextStyle` still point at Word ids; re-point them now that
  // every incoming style has a Pub id, and drop any that led nowhere.
  for (const style of added) {
    style.basedOn = resolveRef(style.basedOn, mapping, taken)
    style.nextStyle = resolveRef(style.nextStyle, mapping, taken)
  }

  return { mapping, added }
}

function resolveRef(
  ref: string | undefined,
  mapping: Map<string, string>,
  taken: Set<string>
): string | undefined {
  if (!ref) return undefined
  const mapped = mapping.get(ref) ?? builtinForWordStyle(ref)
  return mapped && taken.has(mapped) ? mapped : undefined
}
