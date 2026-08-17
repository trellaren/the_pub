import { useEffect, useRef, useState } from 'react'
import { invoke, attempt, reportNotice } from '@renderer/lib/ipc.js'
import { useProjectStore } from '@renderer/stores/projectStore.js'
import { projectTypes, type ProjectType } from '@shared/model/manifest.js'
import type { SaveTemplateOptions } from '@shared/model/template.js'
import {
  Field,
  TextInput,
  Select,
  Checkbox,
  SectionTitle,
  ToolbarButton
} from '@renderer/ui/primitives.js'
import { useModalFocusTrap } from '@renderer/ui/useModalFocusTrap.js'

/** The opt-in parts of a project, other than the documents. */
const PARTS = [
  { key: 'entities', label: 'Records' },
  { key: 'beats', label: 'Beats and storyboard' },
  { key: 'maps', label: 'Maps' },
  { key: 'manuscript', label: 'Manuscript structure' },
  { key: 'layout', label: 'Panel layout' }
] as const

type PartKey = (typeof PARTS)[number]['key']

/**
 * Turn the open project into a template.
 *
 * Styles and settings always travel — they are what makes a template a
 * template — so they are stated here rather than offered as choices. Everything
 * else starts *off*, matching `saveTemplateOptionsSchema`: a template that
 * quietly carries someone's draft chapter three is a worse failure than one
 * missing a file they meant to include.
 */
export function SaveAsTemplateDialog({ onClose }: { onClose: () => void }) {
  const project = useProjectStore((store) => store.project)
  const [name, setName] = useState(project?.manifest.name ?? '')
  const [description, setDescription] = useState('')
  const [projectType, setProjectType] = useState<ProjectType>(
    project?.manifest.projectType ?? 'novel'
  )
  const [parts, setParts] = useState<Record<PartKey, boolean>>({
    entities: false,
    beats: false,
    maps: false,
    manuscript: false,
    layout: false
  })
  const [documents, setDocuments] = useState<Array<{ path: string; title: string }>>([])
  const [chosen, setChosen] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void (async () => {
      const candidates = await attempt(
        invoke('manuscript:candidates', {}),
        'Could not list the project’s documents'
      )
      if (candidates) setDocuments(candidates.map(({ path, title }) => ({ path, title })))
    })()
  }, [])

  async function save(): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    const options: SaveTemplateOptions = {
      name: trimmed,
      description: description.trim(),
      projectType,
      include: { ...parts, documents: chosen }
    }
    const saved = await attempt(
      invoke('templates:saveAs', { options }),
      'Could not save the template'
    )
    setBusy(false)
    if (!saved) return
    reportNotice(`Saved “${saved.name}” as a template.`)
    onClose()
  }

  const dialogRef = useRef<HTMLDivElement>(null)
  useModalFocusTrap(dialogRef, onClose)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Save project as template"
        className="flex max-h-full w-[34rem] flex-col overflow-hidden rounded border border-border bg-surface"
        data-testid="save-template-dialog"
      >
        <header className="flex items-center border-b border-border px-3 py-2">
          <h2 className="flex-1 text-[13px] text-text">Save project as template</h2>
          <ToolbarButton label="Close" onClick={onClose}>
            ✕
          </ToolbarButton>
        </header>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
          <Field label="Template name">
            <TextInput
              value={name}
              onChange={(event) => setName(event.target.value)}
              data-testid="save-template-name"
            />
          </Field>
          <Field label="Description">
            <TextInput
              value={description}
              placeholder="What this template is for"
              onChange={(event) => setDescription(event.target.value)}
              data-testid="save-template-description"
            />
          </Field>
          <Field label="Project type">
            <Select
              value={projectType}
              onChange={(event) => setProjectType(event.target.value as ProjectType)}
              data-testid="save-template-type"
            >
              {projectTypes.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </Select>
          </Field>

          <SectionTitle>Also include</SectionTitle>
          <p className="mb-2 text-[11px] text-faint">
            Styles and settings are always included. Everything below is copied as it stands today.
          </p>
          {PARTS.map((part) => (
            <Checkbox
              key={part.key}
              label={part.label}
              checked={parts[part.key]}
              onChange={(checked) => setParts((current) => ({ ...current, [part.key]: checked }))}
            />
          ))}

          <SectionTitle>Documents</SectionTitle>
          {documents.length === 0 ? (
            <p className="text-[12px] text-faint">This project has no documents yet.</p>
          ) : (
            documents.map((document) => (
              <Checkbox
                key={document.path}
                label={document.title || document.path}
                checked={chosen.includes(document.path)}
                onChange={(checked) =>
                  setChosen((current) =>
                    checked
                      ? [...current, document.path]
                      : current.filter((path) => path !== document.path)
                  )
                }
              />
            ))
          )}
        </div>

        <footer className="flex justify-end gap-2 border-t border-border px-3 py-2">
          <ToolbarButton label="Cancel" onClick={onClose}>
            Cancel
          </ToolbarButton>
          <ToolbarButton
            label="Save as template"
            onClick={() => void save()}
            disabled={!name.trim() || busy}
            data-testid="save-template-confirm"
          >
            Save Template
          </ToolbarButton>
        </footer>
      </div>
    </div>
  )
}
