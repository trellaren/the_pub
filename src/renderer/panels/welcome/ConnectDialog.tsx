import { useEffect, useState } from 'react'
import type {
  ConnectionProfile,
  ConnectionProtocol,
  DbEngine,
  UntrustedHostKey
} from '@shared/model/connection.js'
import { defaultPort, projectUri, describeConnection } from '@shared/model/connection.js'
import { invoke, attempt } from '@renderer/lib/ipc.js'
import { useProjectStore } from '@renderer/stores/projectStore.js'
import { Field, TextInput, Select, ToolbarButton, Checkbox, cx } from '@renderer/ui/primitives.js'

interface Draft {
  id?: string
  name: string
  protocol: ConnectionProtocol
  host: string
  port: number
  user: string
  auth: 'password' | 'key'
  privateKeyPath: string
  remotePath: string
  secure: boolean
  clientId: string
  tenant: string
  account: string
  signedIn: boolean
  engine: DbEngine
  database: string
  schema: string
}

const BLANK: Draft = {
  name: '',
  protocol: 'sftp',
  host: '',
  port: 22,
  user: '',
  auth: 'password',
  privateKeyPath: '',
  remotePath: '/',
  secure: false,
  clientId: '',
  tenant: 'common',
  account: '',
  signedIn: false,
  engine: 'postgres',
  database: '',
  schema: 'thepub'
}

/** What a server is called when nobody has named it. */
function defaultName(draft: Draft): string {
  if (draft.protocol === 'onedrive') {
    return draft.account ? `OneDrive — ${draft.account}` : 'OneDrive'
  }
  if (draft.protocol === 'db') {
    return draft.engine === 'sqlite'
      ? draft.host || 'SQLite database'
      : `${draft.database || 'database'} on ${draft.host || 'host'}`
  }
  return `${draft.user || 'user'}@${draft.host || 'host'}`
}

/**
 * Saved servers, and opening a project on one.
 *
 * The secret box is deliberately write-only: nothing here can read a stored
 * password back, because no channel returns one. Editing a saved server and
 * leaving the box empty keeps whatever is already stored.
 */
export function ConnectDialog({ onClose }: { onClose: () => void }) {
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([])
  const [secureStorage, setSecureStorage] = useState(true)
  const [draft, setDraft] = useState<Draft>(BLANK)
  const [secret, setSecret] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** The SSH identity awaiting a decision, when a test refused one. */
  const [hostKey, setHostKey] = useState<UntrustedHostKey | null>(null)
  const isOneDrive = draft.protocol === 'onedrive'
  const isDb = draft.protocol === 'db'
  // SQLite is a file on this machine: no host to dial, no user, no password.
  const isSqlite = isDb && draft.engine === 'sqlite'
  /** Set when a test found the server reachable but holding no project yet. */
  const [needsCreate, setNeedsCreate] = useState(false)

  const load = async (): Promise<void> => {
    const result = await attempt(invoke('connections:list', {}), 'Could not load saved servers')
    if (!result) return
    setProfiles(result.connections)
    setSecureStorage(result.secureStorage)
  }

  useEffect(() => {
    void load()
  }, [])

  const edit = (profile: ConnectionProfile): void => {
    setDraft({
      id: profile.id,
      name: profile.name,
      protocol: profile.protocol,
      host: profile.host,
      port: profile.port,
      user: profile.user,
      auth: profile.auth,
      privateKeyPath: profile.privateKeyPath,
      remotePath: profile.remotePath,
      secure: profile.secure,
      clientId: profile.clientId,
      tenant: profile.tenant,
      account: profile.account,
      signedIn: profile.hasSecret,
      engine: profile.engine,
      database: profile.database,
      schema: profile.schema
    })
    setSecret('')
    setStatus(null)
    setHostKey(null)
    setNeedsCreate(false)
  }

  const save = async (): Promise<ConnectionProfile | null> => {
    if (isOneDrive && !draft.clientId.trim()) {
      setStatus('An Application (client) ID is needed.')
      return null
    }
    if (isDb) {
      if (!draft.host.trim()) {
        setStatus(isSqlite ? 'A path to a database file is needed.' : 'A host is needed.')
        return null
      }
      if (!isSqlite && !draft.database.trim()) {
        setStatus('A database name is needed.')
        return null
      }
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(draft.schema.trim())) {
        // Interpolated into DDL, where no placeholder is allowed. Said here so
        // it is caught while it is still being typed rather than on connect.
        setStatus('The schema name must be letters, digits and underscores, starting with a letter.')
        return null
      }
    } else if (!isOneDrive && (!draft.host.trim() || !draft.user.trim())) {
      setStatus('A host and a user are needed.')
      return null
    }
    const saved = await attempt(
      invoke('connections:save', {
        profile: {
          ...draft,
          name: draft.name.trim() || defaultName(draft),
          port: draft.port || defaultPort(draft.protocol, draft.engine)
        },
        // Undefined keeps the stored secret; the field is only sent when typed.
        // A OneDrive profile's secret is its refresh token, which only signing
        // in can produce, so this dialog never sends one for it.
        ...(secret && !isOneDrive ? { secret } : {})
      }),
      'Could not save the server'
    )
    if (saved) {
      setSecret('')
      setDraft((current) => ({ ...current, id: saved.id }))
      await load()
    }
    return saved
  }

  const test = async (): Promise<void> => {
    setBusy(true)
    const saved = await save()
    if (saved) {
      const result = await invoke('connections:test', { id: saved.id }).catch(() => null)
      setStatus(
        result
          ? result.ok
            ? isDb
              ? result.message
              : `${result.message} ${result.entries} items in the folder.`
            : result.message
          : 'Could not reach the server.'
      )
      setHostKey(result?.hostKey ?? null)
      setNeedsCreate(result?.needsCreate ?? false)
    }
    setBusy(false)
  }

  /**
   * Accept the fingerprint the author has just read, then try again.
   *
   * Retrying immediately is the point: accepting an identity is only ever
   * interesting as a step towards a connection, and finishing here means the
   * author sees whether the *rest* of the profile is right in the same breath
   * rather than pressing test twice.
   */
  const acceptHostKey = async (): Promise<void> => {
    if (!draft.id || !hostKey) return
    setBusy(true)
    const result = await invoke('connections:trustHostKey', {
      id: draft.id,
      fingerprint: hostKey.fingerprint
    }).catch(() => null)
    setBusy(false)
    if (!result?.ok) {
      setStatus(result?.message ?? 'That fingerprint could not be accepted.')
      return
    }
    setHostKey(null)
    await test()
  }

  /**
   * Sign in, in the person's own browser.
   *
   * The profile is saved first because sign-in works against a stored profile:
   * the client id and tenant it needs are exactly what is being typed here, and
   * the token it produces has to have somewhere to go.
   */
  const signIn = async (): Promise<void> => {
    setBusy(true)
    const saved = await save()
    if (saved) {
      setStatus('Finish signing in in your browser…')
      const result = await invoke('connections:signIn', { id: saved.id }).catch(() => null)
      setStatus(result ? result.message : 'The sign-in could not be started.')
      if (result?.ok) {
        setDraft((current) => ({ ...current, account: result.account, signedIn: true }))
        await load()
      }
    }
    setBusy(false)
  }

  const signOut = async (): Promise<void> => {
    if (!draft.id) return
    await invoke('connections:signOut', { id: draft.id }).catch(() => {})
    setDraft((current) => ({ ...current, account: '', signedIn: false }))
    setStatus('Signed out on this machine.')
    await load()
  }

  /**
   * Create a project's tables, having said so.
   *
   * A button of its own, never a step folded into opening: writing DDL into
   * someone's database is not something to discover afterwards, and the
   * sentence above it names the schema it is about to create.
   */
  const createDatabase = async (): Promise<void> => {
    const saved = await save()
    if (!saved) return
    setBusy(true)
    const result = await invoke('connections:createDatabase', { id: saved.id }).catch(() => null)
    setBusy(false)
    setStatus(result?.message ?? 'The project could not be created.')
    if (result?.ok) setNeedsCreate(false)
  }

  const openThere = async (profile: ConnectionProfile): Promise<void> => {
    setBusy(true)
    const opened = await useProjectStore.getState().open(projectUri(profile))
    setBusy(false)
    if (opened) onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
      <div
        className="flex max-h-full w-[42rem] flex-col overflow-hidden rounded border border-border bg-surface"
        data-testid="connect-dialog"
      >
        <header className="flex items-center border-b border-border px-3 py-2">
          <h2 className="flex-1 text-[13px] text-text">Connect to a server</h2>
          <ToolbarButton label="Close" onClick={onClose}>
            ✕
          </ToolbarButton>
        </header>

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <ul className="w-48 shrink-0 overflow-y-auto border-r border-border py-1">
            {profiles.map((profile) => (
              <li key={profile.id} className="px-1">
                <button
                  type="button"
                  onClick={() => edit(profile)}
                  onDoubleClick={() => void openThere(profile)}
                  className={cx(
                    'block w-full rounded px-2 py-1 text-left text-[12px]',
                    draft.id === profile.id ? 'bg-surface-3 text-text' : 'text-muted hover:bg-surface-2'
                  )}
                >
                  <span className="block truncate">{profile.name}</span>
                  <span className="block truncate text-[10px] text-faint">
                    {describeConnection(profile)}
                  </span>
                </button>
              </li>
            ))}
            <li className="px-1 pt-1">
              <ToolbarButton
                label="New server"
                className="w-full justify-start"
                onClick={() => {
                  setDraft(BLANK)
                  setSecret('')
                  setStatus(null)
                  setHostKey(null)
                }}
              >
                ＋ new server
              </ToolbarButton>
            </li>
          </ul>

          <div className="min-w-0 flex-1 overflow-y-auto p-3">
            <div className="flex gap-2">
              <Field label="Protocol">
                <Select
                  value={draft.protocol}
                  onChange={(event) => {
                    const protocol = event.target.value as ConnectionProtocol
                    setDraft((current) => ({
                      ...current,
                      protocol,
                      port: defaultPort(protocol, current.engine),
                      // The drive root, not a server path: OneDrive projects
                      // live in a folder inside the drive.
                      remotePath: protocol === 'onedrive' && current.remotePath === '/' ? '' : current.remotePath
                    }))
                    setStatus(null)
                  }}
                  data-testid="connect-protocol"
                >
                  <option value="sftp">SFTP (SSH)</option>
                  <option value="ftp">FTP</option>
                  <option value="onedrive">OneDrive</option>
                  <option value="db">Database</option>
                </Select>
              </Field>
              {isDb ? (
                <Field label="Engine">
                  <Select
                    value={draft.engine}
                    onChange={(event) => {
                      const engine = event.target.value as DbEngine
                      setDraft((current) => ({ ...current, engine, port: defaultPort('db', engine) }))
                      setStatus(null)
                    }}
                    data-testid="connect-engine"
                  >
                    <option value="postgres">PostgreSQL</option>
                    <option value="mysql">MySQL</option>
                    <option value="sqlite">SQLite (a file)</option>
                  </Select>
                </Field>
              ) : null}
              {!isOneDrive && !isSqlite ? (
                <Field label="Port">
                  <TextInput
                    type="number"
                    value={draft.port}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, port: Number(event.target.value) }))
                    }
                  />
                </Field>
              ) : null}
            </div>

            {isOneDrive ? (
              <>
                {/*
                  The client id is asked for rather than shipped. One baked into
                  a desktop binary is a public value anyone can lift and spend
                  someone else's tenant quota with, and it cannot be rotated
                  without shipping a new build — the same reasoning as the AI
                  keys, and the same answer.
                */}
                <p className="mb-2 text-[11px] text-muted">
                  OneDrive needs an app registration of your own. In the Azure portal, register an
                  application, add a <em>Mobile and desktop</em> platform with the redirect URI{' '}
                  <code className="text-text">http://localhost</code>, and paste its Application
                  (client) ID below.
                </p>

                <Field label="Application (client) ID">
                  <TextInput
                    value={draft.clientId}
                    placeholder="00000000-0000-0000-0000-000000000000"
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, clientId: event.target.value }))
                    }
                    data-testid="connect-client-id"
                  />
                </Field>

                <Field label="Directory (tenant)">
                  <TextInput
                    value={draft.tenant}
                    placeholder="common"
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, tenant: event.target.value }))
                    }
                    data-testid="connect-tenant"
                  />
                </Field>

                <p className="mb-2 text-[11px] text-muted" data-testid="connect-account">
                  {draft.signedIn
                    ? `Signed in${draft.account ? ` as ${draft.account}` : ''}.`
                    : 'Not signed in on this machine.'}
                </p>
              </>
            ) : null}

            {!isOneDrive ? (
              <Field label={isSqlite ? 'Database file' : 'Host'}>
                <TextInput
                  value={draft.host}
                  placeholder={isSqlite ? '/home/you/novel.pubdb' : 'files.example.com'}
                  onChange={(event) => setDraft((current) => ({ ...current, host: event.target.value }))}
                  data-testid="connect-host"
                />
              </Field>
            ) : null}

            {isDb && !isSqlite ? (
              <Field label="Database">
                <TextInput
                  value={draft.database}
                  placeholder="thepub"
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, database: event.target.value }))
                  }
                  data-testid="connect-database"
                />
              </Field>
            ) : null}

            {isDb ? (
              <Field label="Schema">
                <TextInput
                  value={draft.schema}
                  placeholder="thepub"
                  onChange={(event) => setDraft((current) => ({ ...current, schema: event.target.value }))}
                  data-testid="connect-schema"
                />
              </Field>
            ) : null}

            {!isOneDrive && !isSqlite ? (
              <Field label="User">
                <TextInput
                  value={draft.user}
                  onChange={(event) => setDraft((current) => ({ ...current, user: event.target.value }))}
                  data-testid="connect-user"
                />
              </Field>
            ) : null}

            {draft.protocol === 'sftp' ? (
              <Field label="Authentication">
                <Select
                  value={draft.auth}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, auth: event.target.value as 'password' | 'key' }))
                  }
                >
                  <option value="password">Password</option>
                  <option value="key">Private key</option>
                </Select>
              </Field>
            ) : null}

            {draft.protocol === 'sftp' && draft.auth === 'key' ? (
              <Field label="Private key file">
                <TextInput
                  value={draft.privateKeyPath}
                  placeholder="C:\\Users\\you\\.ssh\\id_ed25519"
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, privateKeyPath: event.target.value }))
                  }
                />
              </Field>
            ) : null}

            {!isOneDrive && !isSqlite ? (
              <Field
                label={
                  draft.auth === 'key'
                    ? 'Key passphrase (leave blank to keep)'
                    : 'Password (leave blank to keep)'
                }
              >
                <TextInput
                  type="password"
                  value={secret}
                  placeholder="••••••••"
                  onChange={(event) => setSecret(event.target.value)}
                  data-testid="connect-secret"
                />
              </Field>
            ) : null}

            {isDb ? (
              // A database project has no folder: the schema is the whole of
              // where it lives, and offering a path would invite a value
              // nothing would read.
              <p className="mb-2 text-[11px] text-muted">
                One database can hold several projects, one per schema. Nothing outside this
                schema&rsquo;s own tables is read or written.
              </p>
            ) : null}

            {isDb ? null : (
            <Field label={isOneDrive ? 'Folder in your drive' : 'Folder on the server'}>
              <TextInput
                value={draft.remotePath}
                placeholder={isOneDrive ? 'Documents/Novel' : ''}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, remotePath: event.target.value }))
                }
                data-testid="connect-path"
              />
            </Field>
            )}

            {draft.protocol === 'ftp' ? (
              <div className="mb-2">
                <Checkbox
                  label="Explicit TLS (FTPS)"
                  checked={draft.secure}
                  onChange={(secure) => setDraft((current) => ({ ...current, secure }))}
                />
              </div>
            ) : null}

            <Field label="Name">
              <TextInput
                value={draft.name}
                placeholder={defaultName(draft)}
                onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
              />
            </Field>

            {!secureStorage ? (
              <p className="mb-2 text-[11px] text-danger">
                This system has no secure storage, so {isOneDrive ? 'a sign-in' : 'passwords'} cannot
                be kept here.
              </p>
            ) : null}

            {status ? (
              <p className="mb-2 text-[11px] text-muted" data-testid="connect-status">
                {status}
              </p>
            ) : null}

            {/*
              Reviewing a server's SSH identity.

              This is the one moment an author can tell their server apart from
              something pretending to be it, so the fingerprint is shown in full
              and in a monospaced face — it exists to be compared character by
              character against one obtained another way, typically
              `ssh-keygen -lf` on the server itself. Accepting is a button of its
              own rather than a step folded into "test", because a decision made
              on the author's behalf is not a decision they have made.
            */}
            {hostKey ? (
              <div
                className={cx(
                  'mb-2 rounded border p-2',
                  hostKey.verdict === 'changed' ? 'border-danger' : 'border-border'
                )}
                data-testid="connect-host-key"
              >
                <p
                  className={cx(
                    'text-[11px]',
                    hostKey.verdict === 'changed' ? 'text-danger' : 'text-text'
                  )}
                >
                  {hostKey.verdict === 'changed'
                    ? 'This server is offering a different identity than the one accepted before. If nobody has rebuilt it, something may be intercepting the connection.'
                    : 'This server has not been seen on this machine before. Check its fingerprint before accepting it.'}
                </p>
                <p className="mt-1 break-all font-mono text-[11px] text-text" data-testid="connect-fingerprint">
                  {hostKey.algorithm} {hostKey.fingerprint}
                </p>
                {hostKey.previous ? (
                  <p className="mt-1 break-all font-mono text-[11px] text-muted">
                    previously {hostKey.previous}
                  </p>
                ) : null}
                <div className="mt-2">
                  <ToolbarButton
                    label="Accept this server's identity"
                    disabled={busy}
                    data-testid="connect-accept-host-key"
                    onClick={() => void acceptHostKey()}
                  >
                    {hostKey.verdict === 'changed' ? 'accept the new fingerprint' : 'accept fingerprint'}
                  </ToolbarButton>
                </div>
              </div>
            ) : null}

            {/*
              Creating tables in someone's database, said out loud.

              The alternative — opening a project and quietly running DDL —
              is the kind of thing that gets an application banned from a
              company's production server, and rightly.
            */}
            {needsCreate ? (
              <div className="mb-2 rounded border border-border p-2" data-testid="connect-create-db">
                <p className="text-[11px] text-text">
                  There is no project in this database yet. Creating one adds three tables
                  {draft.engine === 'postgres'
                    ? ` to a new "${draft.schema}" schema`
                    : ` named "${draft.schema}_pub_files", "${draft.schema}_pub_changes" and "${draft.schema}_pub_meta"`}
                  . Nothing else in the database is touched.
                </p>
                <div className="mt-2">
                  <ToolbarButton
                    label="Create the project tables in this database"
                    disabled={busy}
                    data-testid="connect-create-db-confirm"
                    onClick={() => void createDatabase()}
                  >
                    create the project here
                  </ToolbarButton>
                </div>
              </div>
            ) : null}

            <div className="flex flex-wrap gap-1">
              <ToolbarButton label="Save this server" disabled={busy} onClick={() => void save()}>
                save
              </ToolbarButton>
              {isOneDrive ? (
                <ToolbarButton
                  label="Sign in to OneDrive in your browser"
                  disabled={busy}
                  data-testid="connect-signin"
                  onClick={() => void signIn()}
                >
                  {draft.signedIn ? 'sign in again' : 'sign in'}
                </ToolbarButton>
              ) : null}
              {isOneDrive && draft.signedIn ? (
                <ToolbarButton label="Sign out on this machine" disabled={busy} onClick={() => void signOut()}>
                  sign out
                </ToolbarButton>
              ) : null}
              <ToolbarButton label="Test the connection" disabled={busy} onClick={() => void test()}>
                test
              </ToolbarButton>
              <ToolbarButton
                label="Open a project here"
                disabled={busy}
                data-testid="connect-open"
                onClick={async () => {
                  const saved = await save()
                  if (saved) await openThere(saved)
                }}
              >
                open project
              </ToolbarButton>
              {draft.id ? (
                <ToolbarButton
                  label={isOneDrive ? 'Forget this drive' : 'Forget this server'}
                  disabled={busy}
                  onClick={async () => {
                    await invoke('connections:delete', { id: draft.id! }).catch(() => {})
                    setDraft(BLANK)
                    await load()
                  }}
                >
                  forget
                </ToolbarButton>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
