import type { VfsEntry, VfsCapabilities, FileChangeEvent } from '../../shared/model/vfs.js'

export type Unwatch = () => Promise<void>

/**
 * The only filesystem surface the rest of the app knows about.
 *
 * Every path is project-relative and POSIX-separated; adapters resolve them
 * against their own root. Local, SFTP, FTP and OneDrive backends all satisfy
 * this, so the file tree, editor, autosave and search index work unchanged
 * whichever one a project lives on.
 */
export interface VfsAdapter {
  readonly caps: VfsCapabilities
  /** Absolute path or URI the adapter is rooted at, for display. */
  readonly root: string

  list(dir: string): Promise<VfsEntry[]>
  stat(path: string): Promise<VfsEntry | null>
  readFile(path: string): Promise<Buffer>
  writeFile(path: string, data: Buffer): Promise<void>
  /** Write via a temporary file so a crash can never leave a half-written document. */
  writeFileAtomic(path: string, data: Buffer): Promise<void>
  mkdir(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  delete(path: string, options?: { recursive?: boolean }): Promise<void>
  /** Recursively list files, skipping `ignoredDirs`. Used by the search indexer. */
  walk(dir: string, ignoredDirs: string[]): Promise<VfsEntry[]>
  watch(dir: string, onChange: (events: FileChangeEvent[]) => void): Promise<Unwatch>
  dispose(): Promise<void>
}
