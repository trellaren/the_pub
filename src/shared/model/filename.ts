/**
 * What makes a file name safe to write.
 *
 * These rules are Windows' rules, and they are applied on every platform on
 * purpose. A portable name is a property of the *project*, not of the machine
 * that happens to be running the app: a folder written on Linux and synced to a
 * Windows laptop breaks there, and this app already serves projects over SFTP
 * and FTP to clients it will never see. Refusing the name once, where the
 * author typed it, beats an errno on someone else's machine a week later.
 *
 * Two of the rules matter more than they look:
 *
 * - Windows *silently strips* a trailing dot or space. Allowing them means a
 *   rename can appear to succeed and produce a different name than was typed,
 *   which is worse than refusing it.
 * - The reserved device names are reserved with any extension, so `CON.pubdoc`
 *   fails exactly as `CON` does.
 */

/** Characters no Windows filesystem accepts. `/` is a separator everywhere. */
const ILLEGAL_CHARACTERS = /[<>:"/\\|?*]/
const ILLEGAL_CHARACTERS_GLOBAL = /[<>:"/\\|?*]/g
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const CONTROL_CHARACTERS_GLOBAL = /[\u0000-\u001f\u007f]/g

/** MS-DOS device names, still reserved forty years on. */
const RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 10 }, (_unused, index) => `com${index}`),
  ...Array.from({ length: 10 }, (_unused, index) => `lpt${index}`)
])

/** Windows' per-component limit. Path length is a separate matter, checked on write. */
export const MAX_NAME_LENGTH = 255

export type NameCheck = { ok: true } | { ok: false; reason: string }

/**
 * Check a single path component — a file or folder name, never a path.
 *
 * The messages are written to be shown to an author verbatim, so they say what
 * is wrong rather than naming a rule.
 */
export function validateFileName(name: string): NameCheck {
  if (name.length === 0) return { ok: false, reason: 'A name is needed.' }
  if (name === '.' || name === '..') {
    return { ok: false, reason: `"${name}" means a folder, so it cannot be a name.` }
  }
  if (name.length > MAX_NAME_LENGTH) {
    return { ok: false, reason: `Names cannot be longer than ${MAX_NAME_LENGTH} characters.` }
  }
  const illegal = ILLEGAL_CHARACTERS.exec(name)
  if (illegal) {
    return { ok: false, reason: `A name cannot contain ${illegal[0]}` }
  }
  if (CONTROL_CHARACTERS.test(name)) {
    return { ok: false, reason: 'A name cannot contain control characters.' }
  }
  if (name.endsWith(' ')) return { ok: false, reason: 'A name cannot end with a space.' }
  if (name.endsWith('.')) return { ok: false, reason: 'A name cannot end with a dot.' }
  const stem = name.split('.')[0]!.toLowerCase()
  if (RESERVED_NAMES.has(stem)) {
    return { ok: false, reason: `"${stem.toUpperCase()}" is a reserved device name on Windows.` }
  }
  return { ok: true }
}

/**
 * Check every component of a project-relative path.
 *
 * Paths reaching the VFS are already normalised POSIX, so splitting on `/` is
 * enough; a backslash inside a component is caught as an illegal character,
 * which is the right answer on a platform where it is a separator.
 */
export function validateRelativePath(path: string): NameCheck {
  const parts = path.split('/').filter((part) => part.length > 0)
  if (parts.length === 0) return { ok: false, reason: 'A name is needed.' }
  for (const part of parts) {
    const result = validateFileName(part)
    if (!result.ok) return result
  }
  return { ok: true }
}

/**
 * Make a name safe rather than rejecting it.
 *
 * Only for names Quoth generates from data it did not choose — a chapter
 * title lifted out of an imported document, say. Anything an author typed is
 * validated and refused instead, because quietly renaming their file is how you
 * lose their trust.
 */
export function sanitizeFileName(name: string, fallback = 'Untitled'): string {
  let cleaned = name
    .replace(ILLEGAL_CHARACTERS_GLOBAL, ' ')
    .replace(CONTROL_CHARACTERS_GLOBAL, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, MAX_NAME_LENGTH)
  if (RESERVED_NAMES.has(cleaned.split('.')[0]!.toLowerCase())) cleaned = `${cleaned}-file`
  return cleaned.length > 0 ? cleaned : fallback
}
