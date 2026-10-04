import { TextInput, Field } from '@renderer/ui/primitives.js'
import type { Draft, SetDraft } from './useConnectionDraft.js'

export function OneDriveSignIn({ draft, setDraft }: { draft: Draft; setDraft: SetDraft }) {
  return (
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
  )
}
