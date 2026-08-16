import { useState } from 'react'
import type { RecentProject } from '@shared/model/app.js'
import { useProjectStore } from '@renderer/stores/projectStore.js'
import { useAppStore } from '@renderer/stores/appStore.js'
import { PanelShell } from '@renderer/ui/primitives.js'
import { runCommand } from '@renderer/commands/registry.js'
import { ConnectDialog } from './ConnectDialog.js'

const NO_RECENTS: RecentProject[] = []

export function WelcomePanel() {
  const project = useProjectStore((store) => store.project)
  const openDialog = useProjectStore((store) => store.openDialog)
  const open = useProjectStore((store) => store.open)
  // Shared constant rather than a fresh `[]`: zustand compares selector results
  // by identity, so a new array every render loops forever.
  const recents = useAppStore((store) => store.state?.recentProjects) ?? NO_RECENTS
  const [connecting, setConnecting] = useState(false)

  return (
    <PanelShell className="bg-bg">
      <div className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-6 p-10">
        <div>
          <h1 className="font-[var(--font-read)] text-3xl text-text">The Pub</h1>
          <p className="mt-1 text-[13px] text-muted" data-testid="welcome-project-root">
            {project ? project.root : 'A workshop for long stories.'}
          </p>
        </div>

        <div className="flex flex-col items-start gap-2">
          <button
            type="button"
            onClick={() => void runCommand('project.newFromTemplate')}
            className="rounded border border-accent bg-accent-soft px-3 py-1.5 text-[13px] text-accent hover:brightness-110"
            data-testid="open-new-project"
          >
            New project from a template…
          </button>
          <button
            type="button"
            onClick={() => void openDialog()}
            className="rounded border border-border px-3 py-1.5 text-[13px] text-muted hover:border-faint hover:text-text"
          >
            Open a project folder…
          </button>
          <button
            type="button"
            onClick={() => setConnecting(true)}
            className="rounded border border-border px-3 py-1.5 text-[13px] text-muted hover:border-faint hover:text-text"
            data-testid="open-connect"
          >
            Connect to a server…
          </button>
          <p className="text-[12px] text-faint">
            Any folder becomes a project — on this machine, in OneDrive, or over SFTP or FTP. The Pub
            keeps its notes in <code>.thepub</code> beside your work.
          </p>
        </div>

        {recents.length > 0 ? (
          <div>
            <h2 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">Recent</h2>
            <ul className="flex flex-col">
              {recents.slice(0, 8).map((recent) => (
                <li key={recent.uri}>
                  <button
                    type="button"
                    onClick={() => void open(recent.uri)}
                    className="w-full truncate rounded px-2 py-1 text-left text-[12px] text-muted hover:bg-surface-2 hover:text-text"
                    title={recent.uri}
                  >
                    <span className="text-text">{recent.name}</span>
                    <span className="ml-2 text-faint">{recent.uri}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      {connecting ? <ConnectDialog onClose={() => setConnecting(false)} /> : null}
    </PanelShell>
  )
}
