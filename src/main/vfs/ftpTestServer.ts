import net from 'node:net'
import { AddressInfo } from 'node:net'
import FtpSrv from 'ftp-srv'

/**
 * A real FTP server, serving a real directory, for tests.
 *
 * The counterpart to `sftpTestServer`, and it exists for the same reason: the
 * remote adapters are protocol handling almost end to end, so a fake would only
 * prove that the fake agrees with itself. `ftp-srv` is already a devDependency
 * — `e2e/remote.spec.ts` has driven the whole app against it since Phase 7 —
 * but nothing has ever exercised `FtpAdapter` on its own, which is how it kept
 * the very defect its SFTP sibling was fixed for in Phase 10.
 *
 * Under `src/` rather than `e2e/` so the unit tests and the end-to-end suite
 * share one copy. Nothing reachable from `src/main/index.ts` imports it, so it
 * never enters the bundle.
 */
export interface FtpTestServer {
  port: number
  /** How many control connections have been accepted since the server started. */
  connectionCount: () => number
  /** How many are still open, which is how a leaked socket shows up. */
  openConnections: () => number
  /** Cut every open connection, to exercise the adapter's reconnect. */
  dropConnections: () => Promise<void>
  close: () => Promise<void>
}

export interface FtpTestServerOptions {
  /** The password accepted. Any password is accepted without this. */
  password?: string
  /** The user accepted. Any user is accepted without this. */
  user?: string
}

/**
 * A port nothing else is listening on.
 *
 * Port 0 is not an option here the way it is for SSH: FTP's passive mode makes
 * the server tell the client where to open the data connection, so it has to
 * know its own address before it binds. Asking the OS for a port and then
 * handing it straight back is the closest thing to the same guarantee — a fixed
 * high port would collide the moment two suites ran at once.
 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo
      probe.close(() => resolve(port))
    })
  })
}

/** The shape ftp-srv expects of a bunyan logger, doing nothing. */
function silentLog(): unknown {
  const noop = (): void => {}
  const logger: Record<string, unknown> = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop
  }
  logger['child'] = () => logger
  return logger
}

export async function startFtpServer(root: string, options: FtpTestServerOptions = {}): Promise<FtpTestServer> {
  const port = await freePort()
  const server = new FtpSrv({
    url: `ftp://127.0.0.1:${port}`,
    pasv_url: '127.0.0.1',
    anonymous: true,
    // ftp-srv logs every command through bunyan, which buries a test report in
    // JSON. A failing test says what went wrong by failing.
    log: silentLog()
  })

  const open = new Set<string>()
  let accepted = 0

  // `connect` is emitted by ftp-srv but missing from its typings, which declare
  // only login, disconnect and client-error.
  ;(server as unknown as { on: (event: string, listener: (data: { id: string }) => void) => void }).on(
    'connect',
    ({ id }) => {
      accepted += 1
      open.add(id)
    }
  )
  server.on('disconnect', ({ id }) => open.delete(id))
  // A dropped connection is a normal end to a test, not a failure.
  server.on('client-error', () => {})

  server.on('login', ({ username, password }, resolve, reject) => {
    const userOk = options.user === undefined || username === options.user
    const passwordOk = options.password === undefined || password === options.password
    if (userOk && passwordOk) resolve({ root })
    else reject(new Error('Not permitted'))
  })

  await server.listen()

  return {
    port,
    connectionCount: () => accepted,
    openConnections: () => open.size,
    dropConnections: async () => {
      await Promise.all([...open].map((id) => server.disconnectClient(id)))
      open.clear()
    },
    close: async () => {
      await server.close()
    }
  }
}
