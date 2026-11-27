/**
 * Stands in for the modules a WebView cannot have: raw sockets, child
 * processes, the SFTP/FTP/SQL clients built on them. Importing one is fine —
 * desktop code that is bundled but never reached does — and using one says
 * plainly why it failed.
 */
function unavailable(): never {
  throw new Error('This is not available in the iOS app.')
}

const trap: unknown = new Proxy(unavailable, {
  get: (_target, property) => (property === 'then' ? undefined : trap),
  apply: unavailable,
  construct: unavailable
})

export default trap
export const Client = trap
export const Pool = trap
export const createServer = trap
export const createConnection = trap
export const createPool = trap
export const spawn = trap
export const pipeline = trap
export const Readable = trap
export const Writable = trap
export const utils = trap
export const FileType = trap
export const DatabaseSync = trap
