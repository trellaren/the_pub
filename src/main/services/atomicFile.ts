import fs from 'node:fs'
import path from 'node:path'
import { ulid } from 'ulid'

/**
 * Replace a small app-data file in one step, so a crash mid-write leaves the
 * previous contents rather than a truncated file — for the key and connection
 * stores, a truncated file parses as "nothing saved" and loses every secret.
 *
 * Synchronous on purpose: these stores expose synchronous APIs and the files
 * are a few kilobytes. Project files go through `VfsAdapter.writeFileAtomic`.
 */
export function writeFileAtomicSync(file: string, data: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp-${ulid()}`
  try {
    fs.writeFileSync(temp, data, mode === undefined ? undefined : { mode })
    fs.renameSync(temp, file)
  } catch (error) {
    fs.rmSync(temp, { force: true })
    throw error
  }
}
