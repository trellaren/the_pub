import type { VfsEntry } from '@shared/model/vfs.js'

export interface TreeNode extends VfsEntry {
  depth: number
}

/** The visible rows: each loaded directory's entries, expanded dirs recursed. */
export function flatten(
  directory: string,
  children: Record<string, VfsEntry[]>,
  expanded: Set<string>,
  depth: number
): TreeNode[] {
  const entries = children[directory]
  if (!entries) return []
  const rows: TreeNode[] = []
  for (const entry of entries) {
    rows.push({ ...entry, depth })
    if (entry.kind === 'dir' && expanded.has(entry.path)) {
      rows.push(...flatten(entry.path, children, expanded, depth + 1))
    }
  }
  return rows
}

/**
 * Where a new item belongs relative to a selection: inside a selected folder,
 * beside a selected file.
 *
 * Decided by the entry's kind, not by whether its listing happens to be loaded
 * — the earlier version asked `children[path] !== undefined`, which sent a
 * selected-but-never-expanded folder's new file to the folder's *parent*.
 */
export function parentFor(path: string, kind: VfsEntry['kind']): string {
  if (kind === 'dir') return path
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

/** The entry at a path, from whichever loaded directory listing holds it. */
export function findEntry(path: string, children: Record<string, VfsEntry[]>): VfsEntry | null {
  const slash = path.lastIndexOf('/')
  const directory = slash === -1 ? '' : path.slice(0, slash)
  return children[directory]?.find((entry) => entry.path === path) ?? null
}

/** Every directory above a path, root first: 'a/b/c' → ['', 'a', 'a/b']. */
export function ancestorsOf(path: string): string[] {
  const found = ['']
  let current = ''
  for (const segment of path.split('/').slice(0, -1)) {
    current = current ? `${current}/${segment}` : segment
    found.push(current)
  }
  return found
}
