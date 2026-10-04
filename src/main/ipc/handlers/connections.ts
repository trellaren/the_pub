import { ConnectionStore } from '../../services/connectionStore.js'
import { KnownHostsStore } from '../../services/knownHostsStore.js'
import { createAdapter, inspectDatabase, createDatabaseProject } from '../../vfs/vfsRegistry.js'
import { KnownHostsPolicy, hostKeyId, type HostKeyPolicy, type PresentedHostKey } from '../../vfs/hostKeys.js'
import type { VfsAdapter } from '../../vfs/types.js'
import { projectUri, defaultPort } from '../../../shared/model/connection.js'
import type { HandlerContext } from '../context.js'

/** A host key offered during a connection test, held until the author rules on it. */
interface PendingHostKey {
  hostId: string
  presented: PresentedHostKey
  verdict: 'unknown' | 'changed'
  previous: string
}

export function register({ handle, oneDrive }: HandlerContext): void {
  const connections = new ConnectionStore()
  // A second instance of the same file-backed store the VFS registry uses, as
  // with `ConnectionStore` above: both read on every call, so the file is the
  // single source of truth and there is no cache for the two to disagree about.
  const knownHosts = new KnownHostsStore()
  const hostKeys = new KnownHostsPolicy(knownHosts)
  /** By profile id, replaced on each test and cleared once accepted. */
  const pendingHostKeys = new Map<string, PendingHostKey>()

  handle('connections:list', () => ({
    connections: connections.list(),
    secureStorage: connections.secureStorageAvailable()
  }))

  handle('connections:save', ({ profile, secret }) =>
    connections.save(
      { ...profile, port: profile.port || defaultPort(profile.protocol) },
      secret
    )
  )

  handle('connections:delete', ({ id }) => {
    connections.remove(id)
    // The accepted host key stays: it belongs to the host, not to this profile,
    // and another profile — or this one, saved again — reaches the same server.
    pendingHostKeys.delete(id)
    return { ok: true as const }
  })

  /**
   * Open the connection and read its root.
   *
   * Worth its own channel: a typo in a host or a path otherwise surfaces as a
   * project that opens empty, which reads like data loss rather than a mistake.
   */
  handle('connections:test', async ({ id }) => {
    const profile = connections.get(id)
    if (!profile) {
      return { ok: false, message: 'That server is no longer saved.', entries: 0, hostKey: null, needsCreate: false }
    }

    /*
     * A database asks a different question.
     *
     * "Reachable, but holding no project" is not a failure — the server is fine
     * and the tables are simply not there — so it comes back as an offer to
     * create them rather than as an error the writer has to interpret.
     */
    if (profile.protocol === 'db') {
      try {
        const { exists, tooNew } = await inspectDatabase(profile.id)
        if (tooNew) {
          return {
            ok: false,
            message: 'That database holds a project written by a newer version of Quoth.',
            entries: 0,
            hostKey: null,
            needsCreate: false
          }
        }
        return {
          ok: true,
          message: exists
            ? `Connected. A project is already here in the "${profile.schema}" schema.`
            : `Connected. There is no project here yet — one can be created in the "${profile.schema}" schema.`,
          entries: 0,
          hostKey: null,
          needsCreate: !exists
        }
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
          entries: 0,
          hostKey: null,
          needsCreate: false
        }
      }
    }

    /*
     * Watch what the host-key policy turns away.
     *
     * The wrapper only observes — the verdict is still the real policy's, so
     * testing a connection can never accept a key that opening a project would
     * refuse. Recording it here is what lets the dialog show the fingerprint
     * instead of a bare failure, and it is the only place the key is kept:
     * accepting one has to happen while this record is still in hand.
     */
    const refused: PendingHostKey[] = []
    const watching: HostKeyPolicy = {
      check: (host, port, key) => {
        const decision = hostKeys.check(host, port, key)
        if (!decision.ok) {
          refused.push({
            hostId: hostKeyId(host, port),
            presented: decision.presented,
            verdict: decision.verdict,
            previous: decision.previous
          })
        }
        return decision
      }
    }

    // Building the adapter is inside the try because it is one of the ways this
    // fails: an unreadable private key, or a OneDrive profile with no client
    // id, throws here rather than on connect. Left outside, those escaped the
    // handler entirely and the dialog fell back to "Could not reach the
    // server." — which sends the author looking for a network fault when the
    // actual problem is a path they can see and fix.
    let adapter: VfsAdapter | null = null
    try {
      adapter = createAdapter(projectUri(profile), { hostKeys: watching })
      const entries = await adapter.list('')
      const where = profile.protocol === 'onedrive' ? profile.account || 'OneDrive' : profile.host
      return { ok: true, message: `Connected to ${where}.`, entries: entries.length, hostKey: null, needsCreate: false }
    } catch (error) {
      const pending = refused.at(-1) ?? null
      if (pending) pendingHostKeys.set(id, pending)
      else pendingHostKeys.delete(id)
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        entries: 0,
        hostKey: pending
          ? { ...pending.presented, verdict: pending.verdict, previous: pending.previous }
          : null,
        needsCreate: false
      }
    } finally {
      await adapter?.dispose().catch(() => {})
    }
  })

  handle('connections:createDatabase', async ({ id }) => {
    try {
      await createDatabaseProject(id)
      return { ok: true, message: 'The project tables have been created.' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })

  /**
   * Accept a host key the author has just read the fingerprint of.
   *
   * Only the key main saw during that profile's most recent test can be
   * accepted, and only when the renderer echoes back the fingerprint it
   * displayed. That is what keeps this from being a channel that writes
   * arbitrary trust: a dialog left open while the server changed underneath it
   * commits nothing, because the fingerprint no longer matches.
   */
  handle('connections:trustHostKey', ({ id, fingerprint }) => {
    const pending = pendingHostKeys.get(id)
    if (!pending) {
      return { ok: false, message: 'Test the connection again before accepting its fingerprint.' }
    }
    if (pending.presented.fingerprint !== fingerprint) {
      return { ok: false, message: 'That fingerprint is out of date. Test the connection again.' }
    }
    knownHosts.trust(pending.hostId, pending.presented)
    pendingHostKeys.delete(id)
    return { ok: true, message: 'This server’s identity has been accepted.' }
  })

  /**
   * Sign in to OneDrive.
   *
   * The failure is returned rather than thrown: every way this goes wrong is
   * something the author can fix — the wrong client id, a redirect URI the
   * registration does not list, a consent dialog they closed — and the dialog
   * shows the message beside the fields that caused it.
   */
  handle('connections:signIn', async ({ id }) => {
    try {
      const { account } = await oneDrive.signIn(id)
      return { ok: true, account, message: account ? `Signed in as ${account}.` : 'Signed in.' }
    } catch (error) {
      return { ok: false, account: '', message: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('connections:signOut', ({ id }) => {
    oneDrive.signOut(id)
    return { ok: true as const }
  })

  handle('connections:cancelSignIn', ({ id }) => {
    oneDrive.cancel(id)
    return { ok: true as const }
  })
}
