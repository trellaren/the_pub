import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type {
  ConnectionProfile,
  ConnectionProtocol,
  DbEngine,
  UntrustedHostKey
} from '@shared/model/connection.js'
import { defaultPort, projectUri } from '@shared/model/connection.js'
import { invoke, attempt, errorMessage } from '@renderer/lib/ipc.js'
import { useProjectStore } from '@renderer/stores/projectStore.js'

export interface Draft {
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

export const BLANK: Draft = {
  name: '',
  protocol: 'sftp',
  host: '',
  port: 22,
  user: '',
  auth: 'password',
  privateKeyPath: '',
  remotePath: '/',
  // On for new profiles: plain FTP sends the password in the clear.
  secure: true,
  clientId: '',
  tenant: 'common',
  account: '',
  signedIn: false,
  engine: 'postgres',
  database: '',
  schema: 'thepub'
}

/** What a server is called when nobody has named it. */
export function defaultName(draft: Draft): string {
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

export type SetDraft = Dispatch<SetStateAction<Draft>>

export function useConnectionDraft(onClose: () => void) {
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([])
  const [secureStorage, setSecureStorage] = useState(true)
  const [draft, setDraft] = useState<Draft>(BLANK)
  const [secret, setSecret] = useState('')
  const [status, setStatusText] = useState<string | null>(null)
  const [statusIsError, setStatusIsError] = useState(false)
  const setStatus = (text: string | null, isError = false): void => {
    setStatusText(text)
    setStatusIsError(isError)
  }
  const fail = (text: string): void => setStatus(text, true)
  const [busy, setBusy] = useState(false)
  /** A sign-in handed to the browser and not yet come back. */
  const [signingIn, setSigningIn] = useState(false)
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
      fail('An Application (client) ID is needed.')
      return null
    }
    if (isDb) {
      if (!draft.host.trim()) {
        fail(isSqlite ? 'A path to a database file is needed.' : 'A host is needed.')
        return null
      }
      if (!isSqlite && !draft.database.trim()) {
        fail('A database name is needed.')
        return null
      }
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(draft.schema.trim())) {
        // Interpolated into DDL, where no placeholder is allowed. Said here so
        // it is caught while it is still being typed rather than on connect.
        fail('The schema name must be letters, digits and underscores, starting with a letter.')
        return null
      }
    } else if (!isOneDrive && (!draft.host.trim() || !draft.user.trim())) {
      fail('A host and a user are needed.')
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

  /**
   * A test needs a stored profile to dial, so a server that has never been
   * saved is saved for it — and removed again if the test fails outright,
   * so a mistyped host does not linger in the list. One that answered with
   * a host key or an empty database stays: the next step needs its id.
   */
  const runTest = async (): Promise<void> => {
    const wasNew = !draft.id
    const saved = await save()
    if (!saved) return
    const result = await invoke('connections:test', { id: saved.id }).catch(
      (error: unknown) => ({ ok: false as const, message: errorMessage(error), entries: 0, hostKey: undefined, needsCreate: false })
    )
    if (result.ok) {
      setStatus(isDb ? result.message : `${result.message} ${result.entries} items in the folder.`)
    } else {
      fail(result.message || 'Could not reach the server.')
    }
    setHostKey(result.hostKey ?? null)
    setNeedsCreate(result.needsCreate ?? false)
    if (wasNew && !result.ok && !result.hostKey && !result.needsCreate) {
      await invoke('connections:delete', { id: saved.id }).catch(() => {})
      setDraft((current) => ({ ...current, id: undefined }))
      await load()
    }
  }

  const test = async (): Promise<void> => {
    setBusy(true)
    try {
      await runTest()
    } finally {
      setBusy(false)
    }
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
    try {
      const result = await invoke('connections:trustHostKey', {
        id: draft.id,
        fingerprint: hostKey.fingerprint
      }).catch((error: unknown) => ({ ok: false, message: errorMessage(error) }))
      if (!result.ok) {
        fail(result.message || 'That fingerprint could not be accepted.')
        return
      }
      setHostKey(null)
      await runTest()
    } finally {
      setBusy(false)
    }
  }

  /**
   * Sign in, in the person's own browser.
   *
   * The profile is saved first because sign-in works against a stored profile:
   * the client id and tenant it needs are exactly what is being typed here, and
   * the token it produces has to have somewhere to go.
   *
   * The wait is held in `signingIn` rather than `busy` deliberately. A sign-in
   * the browser refuses — a client id with a typo, a registration missing its
   * desktop platform — produces nothing here until the listener times out
   * minutes later, and disabling the dialog for that whole time takes away the
   * fields that would have fixed it.
   */
  const signIn = async (): Promise<void> => {
    setBusy(true)
    const saved = await save()
    setBusy(false)
    if (!saved) return

    setSigningIn(true)
    setStatus('Finish signing in in your browser…')
    const result = await invoke('connections:signIn', { id: saved.id }).catch(() => null)
    setSigningIn(false)
    if (result?.ok) setStatus(result.message)
    else fail(result ? result.message : 'The sign-in could not be started.')
    if (result?.ok) {
      setDraft((current) => ({ ...current, account: result.account, signedIn: true }))
      await load()
    }
  }

  const cancelSignIn = async (): Promise<void> => {
    if (!draft.id) return
    await invoke('connections:cancelSignIn', { id: draft.id }).catch(() => {})
  }

  const signOut = async (): Promise<void> => {
    if (!draft.id) return
    await attempt(invoke('connections:signOut', { id: draft.id }), 'Could not sign out')
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
    const result = await invoke('connections:createDatabase', { id: saved.id }).catch(
      (error: unknown) => ({ ok: false, message: errorMessage(error) })
    )
    setBusy(false)
    if (result.ok) setStatus(result.message)
    else fail(result.message || 'The project could not be created.')
    if (result?.ok) setNeedsCreate(false)
  }

  const openThere = async (profile: ConnectionProfile): Promise<void> => {
    setBusy(true)
    const opened = await useProjectStore.getState().open(projectUri(profile))
    setBusy(false)
    if (opened) onClose()
  }

  const startNew = (): void => {
    setDraft(BLANK)
    setSecret('')
    setStatus(null)
    setHostKey(null)
  }

  const forget = async (): Promise<void> => {
    const label = draft.name.trim() || defaultName(draft)
    const what = isOneDrive ? 'its sign-in' : 'its saved password or key passphrase'
    if (!window.confirm(`Forget "${label}"? This removes the saved server and ${what} from this machine.`)) return
    const deleted = await attempt(invoke('connections:delete', { id: draft.id! }), 'Could not forget it')
    if (deleted === null) return
    setDraft(BLANK)
    await load()
  }

  return {
    profiles,
    secureStorage,
    draft,
    setDraft,
    secret,
    setSecret,
    status,
    statusIsError,
    setStatus,
    busy,
    signingIn,
    hostKey,
    needsCreate,
    isOneDrive,
    isDb,
    isSqlite,
    edit,
    startNew,
    save,
    test,
    acceptHostKey,
    signIn,
    cancelSignIn,
    signOut,
    createDatabase,
    openThere,
    forget
  }
}
