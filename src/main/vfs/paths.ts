import path from 'node:path'

export class VfsPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VfsPathError'
  }
}

/** Convert a platform path to the POSIX form used for every project-relative path. */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/')
}

/**
 * Normalize a project-relative path, rejecting anything that tries to climb out
 * of the project. Absolute paths and `..` segments are errors, not clamps — a
 * renderer sending one is a bug or an attack, and silently rewriting it would
 * hide both.
 */
export function normalizeRelative(rel: string): string {
  const cleaned = rel.replace(/\\/g, '/')
  if (/^[a-zA-Z]:\//.test(cleaned)) throw new VfsPathError(`Absolute path not allowed: ${rel}`)
  const parts: string[] = []
  for (const segment of cleaned.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') throw new VfsPathError(`Path escapes project root: ${rel}`)
    parts.push(segment)
  }
  return parts.join('/')
}

/**
 * Resolve a project-relative path to an absolute one inside `root`.
 *
 * Note: this blocks `..` traversal but not symlinks pointing outside the project.
 * A symlinked chapter folder is a legitimate thing for an author to have, so the
 * containment check deliberately stops at the lexical level.
 */
export function resolveInRoot(root: string, rel: string): string {
  const relative = normalizeRelative(rel)
  const rootResolved = path.resolve(root)
  const absolute = relative ? path.resolve(rootResolved, relative) : rootResolved
  if (absolute !== rootResolved && !absolute.startsWith(rootResolved + path.sep)) {
    throw new VfsPathError(`Path escapes project root: ${rel}`)
  }
  return absolute
}

/** Inverse of `resolveInRoot`: absolute path → project-relative POSIX path. */
export function relativeToRoot(root: string, absolute: string): string {
  return toPosix(path.relative(path.resolve(root), absolute))
}

export function joinRelative(...parts: string[]): string {
  return normalizeRelative(parts.filter(Boolean).join('/'))
}

export function dirnameRelative(rel: string): string {
  const normalized = normalizeRelative(rel)
  const index = normalized.lastIndexOf('/')
  return index === -1 ? '' : normalized.slice(0, index)
}

export function basename(rel: string): string {
  const normalized = normalizeRelative(rel)
  const index = normalized.lastIndexOf('/')
  return index === -1 ? normalized : normalized.slice(index + 1)
}

export function extname(rel: string): string {
  const name = basename(rel)
  const index = name.lastIndexOf('.')
  return index <= 0 ? '' : name.slice(index)
}
