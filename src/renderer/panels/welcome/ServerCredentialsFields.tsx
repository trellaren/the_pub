import { TextInput, Select, Field, Checkbox } from '@renderer/ui/primitives.js'
import type { Draft, SetDraft } from './useConnectionDraft.js'

export function ServerCredentialsFields({
  draft,
  setDraft,
  secret,
  setSecret,
  isOneDrive,
  isSqlite
}: {
  draft: Draft
  setDraft: SetDraft
  secret: string
  setSecret: (secret: string) => void
  isOneDrive: boolean
  isSqlite: boolean
}) {
  return (
    <>
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
    </>
  )
}

export function FtpTlsField({ draft, setDraft }: { draft: Draft; setDraft: SetDraft }) {
  return (
    <div className="mb-2">
      <Checkbox
        label="Explicit TLS (FTPS)"
        checked={draft.secure}
        onChange={(secure) => setDraft((current) => ({ ...current, secure }))}
      />
      {!draft.secure ? (
        <p className="mt-1 text-xs text-amber-600" role="alert">
          Without TLS, your password and files cross the network unencrypted.
        </p>
      ) : null}
    </div>
  )
}
