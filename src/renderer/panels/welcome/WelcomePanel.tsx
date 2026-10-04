import { useEffect, useState } from 'react'
import type { RecentProject } from '@shared/model/app.js'
import { useProjectStore } from '@renderer/stores/projectStore.js'
import { useAppStore } from '@renderer/stores/appStore.js'
import { PanelShell } from '@renderer/ui/primitives.js'
import { RavenMark } from '@renderer/ui/RavenMark.js'
import { runCommand } from '@renderer/commands/registry.js'
import { ConnectDialog } from './ConnectDialog.js'
import { invoke, reportError, errorMessage } from '@renderer/lib/ipc.js'
import type { DailyPrompt } from '@shared/model/writingPrompt.js'
import { defaultVariantFor, findVariant, formatBytes } from '@shared/model/llm.js'
import { aiSettingsSchema } from '@shared/model/ai.js'
import { useChatStore, listenForModelProgress } from '@renderer/stores/chatStore.js'

const NO_RECENTS: RecentProject[] = []

export function WelcomePanel() {
  const project = useProjectStore((store) => store.project)
  const openDialog = useProjectStore((store) => store.openDialog)
  const open = useProjectStore((store) => store.open)
  const opening = useProjectStore((store) => store.opening)
  const forgetRecent = useProjectStore((store) => store.forgetRecent)
  // Shared constant rather than a fresh `[]`: zustand compares selector results
  // by identity, so a new array every render loops forever.
  const recents = useAppStore((store) => store.state?.recentProjects) ?? NO_RECENTS
  const [connecting, setConnecting] = useState(false)

  const openRecent = async (recent: RecentProject): Promise<void> => {
    if (await open(recent.uri, recent.name)) return
    // A project that has moved or been deleted stays in the list forever
    // otherwise, failing the same way every time it is clicked.
    if (window.confirm(`"${recent.name}" could not be opened. Remove it from Recent?`)) {
      await forgetRecent(recent.uri)
    }
  }

  return (
    <PanelShell className="bg-bg">
      <div className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-6 p-10">
        <div>
          <div className="flex items-center gap-3">
            <RavenMark size={34} className="shrink-0 text-text" />
            <h1 className="font-[var(--font-read)] text-3xl text-text">Quoth</h1>
          </div>
          <p className="mt-1 text-[13px] text-muted" data-testid="welcome-project-root">
            {project ? project.root : 'A workshop for long stories.'}
          </p>
        </div>

        <div className="flex flex-col items-start gap-2">
          <button
            type="button"
            onClick={() => void runCommand('project.newFromTemplate')}
            disabled={opening}
            className="rounded border border-accent bg-accent-soft px-3 py-1.5 text-[13px] text-accent hover:brightness-110 disabled:opacity-50"
            data-testid="open-new-project"
          >
            New project from a template…
          </button>
          <button
            type="button"
            onClick={() => void openDialog()}
            disabled={opening}
            className="rounded border border-border px-3 py-1.5 text-[13px] text-muted hover:border-faint hover:text-text disabled:opacity-50"
          >
            Open a project folder…
          </button>
          <button
            type="button"
            onClick={() => setConnecting(true)}
            disabled={opening}
            className="rounded border border-border px-3 py-1.5 text-[13px] text-muted hover:border-faint hover:text-text disabled:opacity-50"
            data-testid="open-connect"
          >
            Connect to a server…
          </button>
          <p className="text-[12px] text-faint">
            Any folder becomes a project — on this machine, in OneDrive, or over SFTP or FTP. Quoth
            keeps its notes in <code>.thepub</code> beside your work.
          </p>
        </div>

        <AssistantSetupCard />

        <DailyPromptCard />

        {recents.length > 0 ? (
          <div>
            <h2 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">Recent</h2>
            <ul className="flex flex-col">
              {recents.slice(0, 8).map((recent) => (
                <li key={recent.uri} className="group flex items-center" data-testid="recent-project">
                  <button
                    type="button"
                    onClick={() => void openRecent(recent)}
                    disabled={opening}
                    className="min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-[12px] text-muted hover:bg-surface-2 hover:text-text disabled:opacity-50"
                    title={recent.uri}
                  >
                    <span className="text-text">{recent.name}</span>
                    <span className="ml-2 text-faint">{recent.uri}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void forgetRecent(recent.uri)}
                    disabled={opening}
                    aria-label={`Remove ${recent.name} from Recent`}
                    title="Remove from Recent"
                    className="shrink-0 rounded px-1.5 py-1 text-[12px] text-faint opacity-0 hover:bg-surface-2 hover:text-text focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-0"
                    data-testid="recent-remove"
                  >
                    ×
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

/**
 * The one question a first launch asks: which model, if any, should answer.
 *
 * Shown until it is answered and then never again. The default is the model
 * this machine can hold, named with its size and licence before a byte moves;
 * "a different one" sends the person to the Assistant panel's settings, where
 * every provider lives; "none" turns AI off, which is the app's existing
 * posture for a writer who wants a plain writing tool, and is undone in
 * Settings.
 */
function AssistantSetupCard() {
  const aiEnabled = useAppStore((store) => store.state?.aiEnabled ?? false)
  const done = useAppStore((store) => store.state?.assistantSetupDone ?? true)
  const llm = useChatStore((store) => store.llm)
  const downloads = useChatStore((store) => store.downloads)
  const [error, setError] = useState<string | null>(null)
  const [started, setStarted] = useState(false)

  useEffect(() => {
    if (aiEnabled && !done) void useChatStore.getState().refreshLlm()
  }, [aiEnabled, done])
  useEffect(() => listenForModelProgress(), [])

  if (!aiEnabled || done) return null

  const variant = llm ? defaultVariantFor(llm.totalMemoryBytes) : null
  const model = variant ? findVariant(variant.id)?.model ?? null : null
  const progress = variant ? downloads[variant.id] : undefined

  const useDefault = async (): Promise<void> => {
    if (!variant || !model) return
    setError(null)
    setStarted(true)
    await useChatStore.getState().saveSettings({
      ...(useChatStore.getState().settings ?? aiSettingsSchema.parse({})),
      provider: 'embedded',
      model: model.id
    }).catch((error: unknown) => reportError(`Could not save the assistant settings: ${errorMessage(error)}`))
    const failure = await useChatStore.getState().downloadModel(variant.id)
    if (failure) {
      setError(failure)
      setStarted(false)
      return
    }
    await useAppStore.getState().setAssistantSetupDone()
  }

  return (
    <div className="rounded border border-accent bg-accent-soft/40 p-3" data-testid="assistant-setup">
      <h2 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">The assistant</h2>
      <p className="mb-2 text-[12px] text-text">
        Quoth can run a model on this machine, so the assistant works with nothing leaving your
        computer and no account to make.
        {variant && model
          ? ` The one that fits this machine is ${model.name} (${formatBytes(variant.bytes || 0) || variant.label}), under the `
          : ' No model in the catalogue fits the memory on this machine, but a hosted provider will work. '}
        {variant && model ? (
          <>
            <a href={model.license.url} target="_blank" rel="noreferrer" className="underline">
              {model.license.name}
            </a>
            .
          </>
        ) : null}
      </p>
      {progress || started ? (
        <p className="mb-2 text-[11px] text-muted" data-testid="assistant-setup-progress">
          Downloading{progress ? ` — ${formatBytes(progress.received)}${progress.total ? ` of ${formatBytes(progress.total)}` : ''}` : '…'}
        </p>
      ) : null}
      {error ? <p className="mb-2 text-[11px] text-danger">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        {variant && model ? (
          <button
            type="button"
            disabled={started}
            onClick={() => void useDefault()}
            className="rounded border border-accent bg-accent-soft px-3 py-1.5 text-[12px] text-accent hover:brightness-110 disabled:opacity-50"
            data-testid="assistant-setup-default"
          >
            Download {model.name}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => {
            void useAppStore.getState().setAssistantSetupDone()
            // The provider picker lives with the chats, which need a project;
            // the panel says so itself when none is open.
            void runCommand('panel.ai')
          }}
          className="rounded border border-border px-3 py-1.5 text-[12px] text-muted hover:border-faint hover:text-text"
          data-testid="assistant-setup-other"
        >
          Choose a different model
        </button>
        <button
          type="button"
          onClick={() => {
            void useAppStore.getState().setAssistantSetupDone()
            void useAppStore.getState().setAiEnabled(false)
          }}
          className="rounded border border-border px-3 py-1.5 text-[12px] text-muted hover:border-faint hover:text-text"
          data-testid="assistant-setup-none"
        >
          No model for now
        </button>
      </div>
      <p className="mt-2 text-[10px] text-faint">
        Change your mind any time in Settings, or in the Assistant panel&rsquo;s ⚙.
      </p>
    </div>
  )
}

/**
 * A prompt for the day, when there is a model already set up to write one.
 *
 * Renders nothing at all otherwise — no placeholder, no "connect an AI to see
 * this". A welcome screen that advertises a feature every time it opens is a
 * welcome screen people stop reading.
 */
function DailyPromptCard() {
  const [prompt, setPrompt] = useState<DailyPrompt | null>(null)

  useEffect(() => {
    void invoke('ai:dailyPrompt', { refresh: false })
      .then((result) => setPrompt(result.text ? result : null))
      .catch(() => setPrompt(null))
  }, [])

  if (!prompt) return null

  return (
    <div
      className="rounded border border-border bg-surface-2 p-3"
      data-testid="welcome-daily-prompt"
    >
      <div className="mb-1 flex items-center gap-2">
        <h2 className="flex-1 text-[11px] font-medium uppercase tracking-wide text-muted">
          Today's prompt
        </h2>
        <button
          type="button"
          onClick={() =>
            void invoke('ai:dailyPrompt', { refresh: true })
              .then((result) => result.text && setPrompt(result))
              .catch((error: unknown) => reportError(`Could not get another prompt: ${errorMessage(error)}`))
          }
          className="text-[11px] text-faint hover:text-text"
        >
          Another
        </button>
      </div>
      <p className="font-[var(--font-read)] text-[14px] leading-relaxed text-text">{prompt.text}</p>
    </div>
  )
}
