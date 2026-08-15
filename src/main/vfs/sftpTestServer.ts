import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { AddressInfo } from 'node:net'
// A default import, not named: `ssh2` is CommonJS and a spread in its own
// index.js defeats Node's export detection, so `import { Server } from 'ssh2'`
// fails under ESM. The adapter gets away with it only because electron-vite
// bundles it; this file is loaded by vitest and Playwright directly.
import ssh2 from 'ssh2'
import type { FileEntry, SFTPWrapper, Attributes } from 'ssh2'

const { Server, utils } = ssh2
// `sftp` hangs off `utils`, despite what ssh2's own README and its bundled
// example both say — theirs throw on this version.
const { STATUS_CODE, flagsToString } = utils.sftp

/**
 * A real SFTP server, serving a real directory, for tests.
 *
 * The remote adapters are almost entirely protocol handling, so a fake would
 * test the fake — the same reasoning that put a real `ftp-srv` behind the FTP
 * suite. This is the SSH equivalent, and it costs no new dependency at all:
 * `ssh2` is already a runtime dependency, so the tests run against the very
 * library the app ships.
 *
 * It lives under `src/` rather than `e2e/` so that both the adapter unit tests
 * and the end-to-end suite can use one copy, the way `docx/fixtures.ts` already
 * does. Nothing reachable from `src/main/index.ts` imports it, so it never
 * enters the bundle.
 */
export interface TestServer {
  port: number
  /** An unencrypted PEM the server will accept for key authentication. */
  clientKey: string
  /**
   * How many connections have been accepted since the server started.
   *
   * SSH servers count sessions against an account, so "the adapter opens one
   * session for a burst of parallel calls" is a claim only the server can
   * settle.
   */
  connectionCount: () => number
  /** How many of those are still open, which is how a leaked socket shows up. */
  openConnections: () => number
  /** Cut every open connection, to exercise the adapter's reconnect. */
  dropConnections: () => void
  close: () => Promise<void>
}

export interface TestServerOptions {
  /** The password accepted for password auth. Any password is accepted without this. */
  password?: string
}

export async function startSftpServer(root: string, options: TestServerOptions = {}): Promise<TestServer> {
  const hostKey = utils.generateKeyPairSync('ed25519').private
  // The client key is RSA because Node's own generator cannot emit an ed25519
  // key in a format ssh2 parses, and this one has to be written to disk as a
  // PEM for the app to read from `privateKeyPath`.
  const clientPair = utils.generateKeyPairSync('rsa', { bits: 2048 })
  const clientPublic = utils.parseKey(clientPair.public)
  if (clientPublic instanceof Error) throw clientPublic

  const connections = new Set<{ end: () => void }>()
  let accepted = 0

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    accepted += 1
    connections.add(client)
    client.on('close', () => connections.delete(client))
    // A dropped connection is a normal end to a test, not a failure.
    client.on('error', () => {})

    client.on('authentication', (context) => {
      if (context.method === 'publickey') {
        const offered = context.key
        if (offered.algo !== clientPublic.type || !clientPublic.getPublicSSH().equals(offered.data)) {
          context.reject()
          return
        }
        // The signature is absent on the first probe, which only asks whether
        // this key would be acceptable at all.
        if (!context.signature) {
          context.accept()
          return
        }
        const { blob, signature } = context
        if (blob && clientPublic.verify(blob, signature, context.hashAlgo)) context.accept()
        else context.reject()
        return
      }

      if (context.method === 'password') {
        if (options.password === undefined || context.password === options.password) context.accept()
        else context.reject()
        return
      }

      context.reject(['password', 'publickey'])
    })

    client.on('ready', () => {
      client.on('session', (accept) => {
        accept().on('sftp', (acceptSftp) => install(acceptSftp(), root))
      })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  return {
    port: (server.address() as AddressInfo).port,
    clientKey: clientPair.private,
    connectionCount: () => accepted,
    openConnections: () => connections.size,
    dropConnections: () => {
      for (const connection of connections) connection.end()
      connections.clear()
    },
    close: async () => {
      for (const connection of connections) connection.end()
      connections.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

type Handle = { kind: 'file'; fd: fs.promises.FileHandle } | { kind: 'dir'; entries: FileEntry[]; sent: boolean }

/**
 * The protocol operations the adapter actually uses.
 *
 * Anything not handled here is auto-rejected by ssh2 with `OP_UNSUPPORTED`
 * rather than hanging, so this deliberately implements only what is reached.
 */
function install(sftp: SFTPWrapper, root: string): void {
  const handles = new Map<number, Handle>()
  let nextHandle = 0

  /**
   * A request path, resolved inside the served directory.
   *
   * The adapter addresses files absolutely — a project rooted at `writes` asks
   * for `/writes/chapter-01.pubdoc` — so the temp directory has to *be* the
   * root. Resolving those against the real filesystem would be both wrong and
   * a way for a test to wander off into the machine.
   */
  const real = (requested: string): string | null => {
    const resolved = path.resolve(root, `.${path.posix.normalize(`/${requested}`)}`)
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return null
    return resolved
  }

  const track = (handle: Handle): Buffer => {
    const id = nextHandle++
    handles.set(id, handle)
    const buffer = Buffer.alloc(4)
    buffer.writeUInt32BE(id, 0)
    return buffer
  }

  const lookup = (handle: Buffer): Handle | undefined => handles.get(handle.readUInt32BE(0))

  const fail = (reqId: number, error: unknown): void => {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE)
    else if (code === 'EACCES' || code === 'EPERM') sftp.status(reqId, STATUS_CODE.PERMISSION_DENIED)
    else sftp.status(reqId, STATUS_CODE.FAILURE)
  }

  sftp.on('REALPATH', (reqId, requested) => {
    const resolved = path.posix.normalize(`/${requested}`)
    sftp.name(reqId, [{ filename: resolved, longname: resolved, attrs: {} as Attributes }])
  })

  const onStat = (reqId: number, requested: string): void => {
    const target = real(requested)
    if (!target) return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE)
    fsp
      .stat(target)
      .then((stats) => sftp.attrs(reqId, toAttrs(stats)))
      .catch((error: unknown) => fail(reqId, error))
  }
  sftp.on('STAT', onStat)
  sftp.on('LSTAT', onStat)

  sftp.on('FSTAT', (reqId, handle) => {
    const open = lookup(handle)
    if (!open || open.kind !== 'file') return sftp.status(reqId, STATUS_CODE.FAILURE)
    open.fd
      .stat()
      .then((stats) => sftp.attrs(reqId, toAttrs(stats)))
      .catch((error: unknown) => fail(reqId, error))
  })

  sftp.on('OPEN', (reqId, filename, flags) => {
    const target = real(filename)
    if (!target) return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE)
    fsp
      .open(target, flagsToString(flags) ?? 'r')
      .then((fd) => sftp.handle(reqId, track({ kind: 'file', fd })))
      .catch((error: unknown) => fail(reqId, error))
  })

  sftp.on('READ', (reqId, handle, offset, length) => {
    const open = lookup(handle)
    if (!open || open.kind !== 'file') return sftp.status(reqId, STATUS_CODE.FAILURE)
    const buffer = Buffer.alloc(length)
    open.fd
      .read(buffer, 0, length, offset)
      .then(({ bytesRead }) =>
        bytesRead === 0 ? sftp.status(reqId, STATUS_CODE.EOF) : sftp.data(reqId, buffer.subarray(0, bytesRead))
      )
      .catch((error: unknown) => fail(reqId, error))
  })

  sftp.on('WRITE', (reqId, handle, offset, data) => {
    const open = lookup(handle)
    if (!open || open.kind !== 'file') return sftp.status(reqId, STATUS_CODE.FAILURE)
    open.fd
      .write(data, 0, data.length, offset)
      .then(() => sftp.status(reqId, STATUS_CODE.OK))
      .catch((error: unknown) => fail(reqId, error))
  })

  sftp.on('CLOSE', (reqId, handle) => {
    const id = handle.readUInt32BE(0)
    const open = handles.get(id)
    handles.delete(id)
    if (open?.kind === 'file') {
      open.fd
        .close()
        .then(() => sftp.status(reqId, STATUS_CODE.OK))
        .catch((error: unknown) => fail(reqId, error))
      return
    }
    sftp.status(reqId, STATUS_CODE.OK)
  })

  sftp.on('OPENDIR', (reqId, requested) => {
    const target = real(requested)
    if (!target) return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE)
    fsp
      .readdir(target)
      .then(async (names) => {
        const entries: FileEntry[] = []
        for (const name of names) {
          const stats = await fsp.stat(path.join(target, name)).catch(() => null)
          if (!stats) continue
          entries.push({ filename: name, longname: longname(name, stats), attrs: toAttrs(stats) })
        }
        sftp.handle(reqId, track({ kind: 'dir', entries, sent: false }))
      })
      .catch((error: unknown) => fail(reqId, error))
  })

  sftp.on('READDIR', (reqId, handle) => {
    const open = lookup(handle)
    if (!open || open.kind !== 'dir') return sftp.status(reqId, STATUS_CODE.FAILURE)
    // Clients call READDIR until it answers EOF; without this flag the listing
    // would be returned forever and the caller would never finish.
    if (open.sent) return sftp.status(reqId, STATUS_CODE.EOF)
    open.sent = true
    sftp.name(reqId, open.entries)
  })

  sftp.on('MKDIR', (reqId, requested) => {
    const target = real(requested)
    if (!target) return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE)
    fsp
      .mkdir(target)
      .then(() => sftp.status(reqId, STATUS_CODE.OK))
      .catch((error: unknown) => fail(reqId, error))
  })

  sftp.on('RMDIR', (reqId, requested) => {
    const target = real(requested)
    if (!target) return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE)
    fsp
      .rmdir(target)
      .then(() => sftp.status(reqId, STATUS_CODE.OK))
      .catch((error: unknown) => fail(reqId, error))
  })

  sftp.on('REMOVE', (reqId, requested) => {
    const target = real(requested)
    if (!target) return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE)
    fsp
      .unlink(target)
      .then(() => sftp.status(reqId, STATUS_CODE.OK))
      .catch((error: unknown) => fail(reqId, error))
  })

  sftp.on('RENAME', (reqId, from, to) => {
    const source = real(from)
    const destination = real(to)
    if (!source || !destination) return sftp.status(reqId, STATUS_CODE.NO_SUCH_FILE)
    /*
     * Refuse a destination that exists.
     *
     * This is the SFTP specification's behaviour and what real servers do —
     * `fs.rename` would silently replace, which would make the test kinder than
     * production and leave the adapter's move-aside fallback unexercised. That
     * fallback is what stops a failed save from destroying the previous draft,
     * so it is exactly the thing worth running here.
     */
    fsp
      .access(destination)
      .then(() => sftp.status(reqId, STATUS_CODE.FAILURE, 'Destination exists'))
      .catch(() =>
        fsp
          .rename(source, destination)
          .then(() => sftp.status(reqId, STATUS_CODE.OK))
          .catch((error: unknown) => fail(reqId, error))
      )
  })

  // The adapter's writeFile carries a mode in its OPEN attributes rather than a
  // separate call, so these only need to not fail.
  sftp.on('SETSTAT', (reqId) => sftp.status(reqId, STATUS_CODE.OK))
  sftp.on('FSETSTAT', (reqId) => sftp.status(reqId, STATUS_CODE.OK))
}

/**
 * `fs.Stats` as SFTP attributes.
 *
 * Times are **seconds**, not milliseconds. The adapter multiplies by 1000 on
 * the way back, so getting this wrong would put every timestamp fifty thousand
 * years in the future and quietly break snapshots and change detection.
 */
function toAttrs(stats: fs.Stats): Attributes {
  return {
    mode: stats.mode,
    uid: stats.uid,
    gid: stats.gid,
    size: stats.size,
    atime: Math.floor(stats.atimeMs / 1000),
    mtime: Math.floor(stats.mtimeMs / 1000)
  }
}

/** The `ls -l` line SFTP listings carry beside the structured attributes. */
function longname(name: string, stats: fs.Stats): string {
  const kind = stats.isDirectory() ? 'd' : '-'
  return `${kind}rw-r--r-- 1 pub pub ${String(stats.size).padStart(8)} Jan  1 00:00 ${name}`
}
