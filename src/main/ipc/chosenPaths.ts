import path from 'node:path'
import { parseUri } from '../vfs/vfsRegistry.js'

/**
 * Local paths the user picked in a native dialog this run.
 *
 * A channel that takes a local path from the renderer would otherwise let a
 * compromised renderer name any file on the machine — a SQLite "database" at
 * `~/.ssh/id_rsa`, a template instantiated over `~/.bashrc`'s folder. Paths
 * reach these channels only after main has shown the dialog and recorded the
 * answer here.
 *
 * The e2e harness cannot drive a native dialog, so it vouches for its own
 * temp paths under a flag only it sets.
 */
export class ChosenPaths {
  private paths = new Set<string>()

  constructor(private readonly trustAll = process.env.QUOTH_E2E_TRUST_PATHS === '1') {}

  record(chosen: string): string {
    this.paths.add(path.resolve(chosen))
    return chosen
  }

  has(candidate: string): boolean {
    return this.trustAll || this.paths.has(path.resolve(candidate))
  }

  /** Throws unless `uri` is remote or a local path that was picked in a dialog. */
  requireLocalChosen(uri: string, what: string): void {
    const { scheme, location } = parseUri(uri)
    if (scheme !== 'local') return
    if (!this.has(location)) throw new Error(`${what} must be chosen in the file dialog.`)
  }
}

export const chosenPaths = new ChosenPaths()
