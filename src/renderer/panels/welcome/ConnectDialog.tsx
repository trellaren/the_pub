import { useRef } from 'react'
import type { ConnectionProtocol, DbEngine } from '@shared/model/connection.js'
import { defaultPort, describeConnection } from '@shared/model/connection.js'
import { Field, TextInput, Select, ToolbarButton, cx } from '@renderer/ui/primitives.js'
import { useModalFocusTrap } from '@renderer/ui/useModalFocusTrap.js'
import { useConnectionDraft, defaultName } from './useConnectionDraft.js'
import { OneDriveSignIn } from './OneDriveSignIn.js'
import { ServerCredentialsFields, FtpTlsField } from './ServerCredentialsFields.js'

/**
 * Saved servers, and opening a project on one.
 *
 * The secret box is deliberately write-only: nothing here can read a stored
 * password back, because no channel returns one. Editing a saved server and
 * leaving the box empty keeps whatever is already stored.
 */
export function ConnectDialog({ onClose }: { onClose: () => void }) {
  const {
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
  } = useConnectionDraft(onClose)

  const dialogRef = useRef<HTMLDivElement>(null)
  useModalFocusTrap(dialogRef, onClose)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Connect to a server"
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
                onClick={startNew}
              >
                ＋ New server
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

            {isOneDrive ? <OneDriveSignIn draft={draft} setDraft={setDraft} /> : null}

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

            <ServerCredentialsFields
              draft={draft}
              setDraft={setDraft}
              secret={secret}
              setSecret={setSecret}
              isOneDrive={isOneDrive}
              isSqlite={isSqlite}
            />

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

            {draft.protocol === 'ftp' ? <FtpTlsField draft={draft} setDraft={setDraft} /> : null}

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
              <p
                className={cx('mb-2 text-[11px]', statusIsError ? 'text-danger' : 'text-muted')}
                role={statusIsError ? 'alert' : 'status'}
                data-testid="connect-status"
              >
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
                    {hostKey.verdict === 'changed' ? 'Accept the new fingerprint' : 'Accept fingerprint'}
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
                    Create the project here
                  </ToolbarButton>
                </div>
              </div>
            ) : null}

            <div className="flex flex-wrap gap-1">
              <ToolbarButton label="Save this server" disabled={busy} onClick={() => void save()}>
                Save
              </ToolbarButton>
              {isOneDrive && signingIn ? (
                <ToolbarButton
                  label="Stop waiting for the browser"
                  data-testid="connect-cancel-signin"
                  onClick={() => void cancelSignIn()}
                >
                  Cancel sign-in
                </ToolbarButton>
              ) : isOneDrive ? (
                <ToolbarButton
                  label="Sign in to OneDrive in your browser"
                  disabled={busy}
                  data-testid="connect-signin"
                  onClick={() => void signIn()}
                >
                  {draft.signedIn ? 'Sign in again' : 'Sign in'}
                </ToolbarButton>
              ) : null}
              {isOneDrive && draft.signedIn && !signingIn ? (
                <ToolbarButton label="Sign out on this machine" disabled={busy} onClick={() => void signOut()}>
                  Sign out
                </ToolbarButton>
              ) : null}
              <ToolbarButton label="Test the connection" disabled={busy} onClick={() => void test()}>
                Test
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
                Open project
              </ToolbarButton>
              {draft.id ? (
                <ToolbarButton
                  label={isOneDrive ? 'Forget this drive' : 'Forget this server'}
                  disabled={busy}
                  onClick={() => void forget()}
                >
                  Forget
                </ToolbarButton>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
