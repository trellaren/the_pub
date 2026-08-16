import { useEffect, useState } from 'react'
import type { TemplateSummary } from '@shared/model/template.js'
import { invoke, attempt } from '@renderer/lib/ipc.js'
import { useProjectStore } from '@renderer/stores/projectStore.js'
import { Field, TextInput, ToolbarButton, cx } from '@renderer/ui/primitives.js'

/**
 * Pick a template, name the project, choose where it goes.
 *
 * The folder is chosen by the native dialog the main process opens as part of
 * `templates:instantiate`, not here — so this dialog never holds a path, and
 * cancelling the folder picker simply leaves it open with the choices intact.
 */
export function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const [templates, setTemplates] = useState<TemplateSummary[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const newFromTemplate = useProjectStore((store) => store.newFromTemplate)

  useEffect(() => {
    void (async () => {
      const list = await attempt(invoke('templates:list', {}), 'Could not list templates')
      if (!list) return
      setTemplates(list)
      setSelected((current) => current ?? list[0]?.id ?? null)
    })()
  }, [])

  const template = templates.find((candidate) => candidate.id === selected) ?? null

  async function create(): Promise<void> {
    if (!template || busy) return
    setBusy(true)
    const project = await newFromTemplate(template.id, name.trim() || template.name)
    setBusy(false)
    // A null result is the folder dialog being cancelled, which is not a
    // failure and must not close this one.
    if (!project) return
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
      <div
        className="flex max-h-full w-[34rem] flex-col overflow-hidden rounded border border-border bg-surface"
        data-testid="new-project-dialog"
      >
        <header className="flex items-center border-b border-border px-3 py-2">
          <h2 className="flex-1 text-[13px] text-text">New project</h2>
          <ToolbarButton label="Close" onClick={onClose}>
            ✕
          </ToolbarButton>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
          <ul className="flex flex-col gap-1" data-testid="template-list">
            {templates.map((candidate) => (
              <li key={candidate.id}>
                <button
                  type="button"
                  onClick={() => setSelected(candidate.id)}
                  onDoubleClick={() => void create()}
                  data-testid={`template-${candidate.id}`}
                  className={cx(
                    'block w-full rounded border px-2 py-1.5 text-left',
                    candidate.id === selected
                      ? 'border-accent bg-accent-soft'
                      : 'border-border hover:bg-surface-2'
                  )}
                >
                  <span className="block text-[13px] text-text">{candidate.name}</span>
                  {candidate.description ? (
                    <span className="mt-0.5 block text-[11px] text-muted">{candidate.description}</span>
                  ) : null}
                </button>
              </li>
            ))}
            {templates.length === 0 ? (
              <li className="px-2 py-1 text-[12px] text-faint">No templates are installed.</li>
            ) : null}
          </ul>

          <Field label="Project name">
            <TextInput
              value={name}
              placeholder={template?.name ?? ''}
              onChange={(event) => setName(event.target.value)}
              data-testid="new-project-name"
            />
          </Field>
        </div>

        <footer className="flex justify-end gap-2 border-t border-border px-3 py-2">
          <ToolbarButton label="Cancel" onClick={onClose}>
            Cancel
          </ToolbarButton>
          <ToolbarButton
            label="Choose a folder and create"
            onClick={() => void create()}
            disabled={!template || busy}
            data-testid="new-project-create"
          >
            Choose Folder…
          </ToolbarButton>
        </footer>
      </div>
    </div>
  )
}
