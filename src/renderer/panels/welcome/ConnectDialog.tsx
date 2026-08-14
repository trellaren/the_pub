import { useEffect, useState } from 'react'
import type { ConnectionProfile, ConnectionProtocol } from '@shared/model/connection.js'
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
  secure: false
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
      secure: profile.secure
    })
    setSecret('')
    setStatus(null)
  }

  const save = async (): Promise<ConnectionProfile | null> => {
    if (!draft.host.trim() || !draft.user.trim()) {
      setStatus('A host and a user are needed.')
      return null
    }
    const saved = await attempt(
      invoke('connections:save', {
        profile: {
          ...draft,
          name: draft.name.trim() || `${draft.user}@${draft.host}`,
          port: draft.port || defaultPort(draft.protocol)
        },
        // Undefined keeps the stored secret; the field is only sent when typed.
        ...(secret ? { secret } : {})
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
            ? `${result.message} ${result.entries} items in the folder.`
            : result.message
          : 'Could not reach the server.'
      )
    }
    setBusy(false)
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
                    setDraft((current) => ({ ...current, protocol, port: defaultPort(protocol) }))
                  }}
                >
                  <option value="sftp">SFTP (SSH)</option>
                  <option value="ftp">FTP</option>
                </Select>
              </Field>
              <Field label="Port">
                <TextInput
                  type="number"
                  value={draft.port}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, port: Number(event.target.value) }))
                  }
                />
              </Field>
            </div>

            <Field label="Host">
              <TextInput
                value={draft.host}
                placeholder="files.example.com"
                onChange={(event) => setDraft((current) => ({ ...current, host: event.target.value }))}
                data-testid="connect-host"
              />
            </Field>

            <Field label="User">
              <TextInput
                value={draft.user}
                onChange={(event) => setDraft((current) => ({ ...current, user: event.target.value }))}
                data-testid="connect-user"
              />
            </Field>

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

            <Field label="Folder on the server">
              <TextInput
                value={draft.remotePath}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, remotePath: event.target.value }))
                }
                data-testid="connect-path"
              />
            </Field>

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
                placeholder={`${draft.user || 'user'}@${draft.host || 'host'}`}
                onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
              />
            </Field>

            {!secureStorage ? (
              <p className="mb-2 text-[11px] text-danger">
                This system has no secure storage, so passwords cannot be saved here.
              </p>
            ) : null}

            {status ? <p className="mb-2 text-[11px] text-muted">{status}</p> : null}

            <div className="flex flex-wrap gap-1">
              <ToolbarButton label="Save this server" disabled={busy} onClick={() => void save()}>
                save
              </ToolbarButton>
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
                  label="Forget this server"
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
