import { useMemo, useState } from 'react'
import type { IDockviewPanelProps } from 'dockview-react'
import type { StoryEntity } from '@shared/model/entity.js'
import { DEFAULT_ENTITY_KINDS, type EntityKindDef } from '@shared/model/entity.js'
import { useProjectStore } from '@renderer/stores/projectStore.js'
import { useEntityStore } from '@renderer/stores/entityStore.js'
import {
  PanelShell,
  PanelHeader,
  EmptyState,
  TextInput,
  TextArea,
  ColorInput,
  ToolbarButton,
  Field,
  Checkbox,
  SectionTitle,
  cx
} from '@renderer/ui/primitives.js'
import { promptForName } from '@renderer/ui/PromptDialog.js'
import { MentionList } from './MentionList.js'
import { EntityNotes } from './EntityNotes.js'

/**
 * Master/detail editor for story records, in StylesPanel's shape.
 *
 * One component for every kind a project offers: they differ only in the
 * label and field suggestions, both of which are project data
 * (`manifest.entityKinds`, or `DEFAULT_ENTITY_KINDS` when a project doesn't
 * configure any) — a second implementation per kind would be the same code
 * with a different noun in it, drifting from this one within a release.
 */
export function EntityPanel({ kind }: { kind: string }) {
  const project = useProjectStore((store) => store.project)
  // Select the stable array and narrow it in a memo. Selecting
  // `entities.filter(...)` would return a fresh array on every render, which is
  // the infinite-loop this codebase has already been bitten by under zustand v5.
  const entities = useEntityStore((store) => store.entities)
  const counts = useEntityStore((store) => store.counts)
  const patch = useEntityStore((store) => store.patch)
  const create = useEntityStore((store) => store.create)
  const remove = useEntityStore((store) => store.remove)

  const kinds = project?.manifest.entityKinds ?? DEFAULT_ENTITY_KINDS
  const labels: EntityKindDef = kinds.find((def) => def.id === kind) ?? {
    id: kind,
    label: kind,
    labelPlural: kind
  }

  const mine = useMemo(() => entities.filter((entity) => entity.kind === kind), [entities, kind])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = mine.find((entity) => entity.id === selectedId) ?? mine[0] ?? null

  const addRecord = async (owner?: Document): Promise<void> => {
    const name = await promptForName({ title: `New ${labels.label}`, ownerDocument: owner })
    if (!name) return
    const entity = await create(kind, name)
    if (entity) setSelectedId(entity.id)
  }

  const removeRecord = async (): Promise<void> => {
    if (!selected) return
    if (!window.confirm(`Delete ${selected.name}? Mentions of the name stay in the prose.`)) return
    await remove(selected.id)
    setSelectedId(null)
  }

  if (!project) {
    return (
      <PanelShell>
        <PanelHeader>{labels.labelPlural}</PanelHeader>
        <EmptyState title="No project open" />
      </PanelShell>
    )
  }

  return (
    <PanelShell>
      <PanelHeader>
        <span className="flex-1">{labels.labelPlural}</span>
        <ToolbarButton
          label={`New ${labels.label}`}
          onClick={(event) => void addRecord(event.currentTarget.ownerDocument)}
        >
          ＋
        </ToolbarButton>
        <ToolbarButton label="Delete record" onClick={() => void removeRecord()} disabled={!selected}>
          ✕
        </ToolbarButton>
      </PanelHeader>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <ul className="w-36 shrink-0 overflow-auto border-r border-border py-1" data-testid={`${kind}-list`}>
          {mine.map((entity) => {
            const count = counts[entity.id]
            return (
              <li key={entity.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(entity.id)}
                  className={cx(
                    'flex w-full items-center gap-1.5 px-2 py-1 text-left text-[12px]',
                    selected?.id === entity.id ? 'bg-surface-3 text-text' : 'text-muted hover:bg-surface-2'
                  )}
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: entity.color ?? 'transparent' }}
                  />
                  <span className="min-w-0 flex-1 truncate">{entity.name}</span>
                  {count ? (
                    <span className="shrink-0 text-[10px] text-faint" title="confirmed / suggested">
                      {count.confirmed}
                      {count.unconfirmed > 0 ? `+${count.unconfirmed}` : ''}
                    </span>
                  ) : null}
                </button>
              </li>
            )
          })}
        </ul>

        {selected ? (
          <EntityDetail
            entity={selected}
            suggestedFields={labels.suggestedFields ?? []}
            onPatch={(changes) => patch(selected.id, changes)}
          />
        ) : (
          <EmptyState
            title={`No ${labels.labelPlural.toLowerCase()} yet`}
            hint={`Add one, then type its name — or @-mention it — in a document.`}
          />
        )}
      </div>
    </PanelShell>
  )
}

function EntityDetail({
  entity,
  suggestedFields,
  onPatch
}: {
  entity: StoryEntity
  suggestedFields: string[]
  onPatch: (changes: Partial<StoryEntity>) => void
}) {
  const used = new Set(entity.fields.map((field) => field.label))
  const unused = suggestedFields.filter((label) => !used.has(label))

  return (
    <div className="min-w-0 flex-1 overflow-y-auto p-3" data-testid="entity-detail">
      <Field label="Name">
        <TextInput
          value={entity.name}
          onChange={(event) => onPatch({ name: event.target.value })}
          data-testid="entity-name"
        />
      </Field>

      <Field label="Summary">
        <TextArea
          rows={3}
          value={entity.summary}
          placeholder="One or two lines to remember them by."
          onChange={(event) => onPatch({ summary: event.target.value })}
        />
      </Field>

      <Field label="Mention colour">
        <ColorInput value={entity.color ?? '#7aa2f7'} onChange={(color) => onPatch({ color })} />
      </Field>

      <SectionTitle>Also known as</SectionTitle>
      {entity.aliases.map((alias, index) => (
        <div key={index} className="mb-2 flex items-center gap-2">
          <TextInput
            value={alias.text}
            onChange={(event) =>
              onPatch({
                aliases: entity.aliases.map((candidate, position) =>
                  position === index ? { ...candidate, text: event.target.value } : candidate
                )
              })
            }
          />
          <Checkbox
            label="Scan"
            checked={alias.scan}
            onChange={(scan) =>
              onPatch({
                aliases: entity.aliases.map((candidate, position) =>
                  position === index ? { ...candidate, scan } : candidate
                )
              })
            }
          />
          <ToolbarButton
            label="Remove alias"
            onClick={() =>
              onPatch({ aliases: entity.aliases.filter((_alias, position) => position !== index) })
            }
          >
            ✕
          </ToolbarButton>
        </div>
      ))}
      <ToolbarButton
        label="Add alias"
        className="mb-2 w-full justify-start"
        onClick={() => onPatch({ aliases: [...entity.aliases, { text: '', scan: true }] })}
      >
        ＋ alias
      </ToolbarButton>

      <Checkbox
        label="Suggest this record where its name appears"
        checked={entity.scan}
        onChange={(scan) => onPatch({ scan })}
      />

      <SectionTitle>Details</SectionTitle>
      {entity.fields.map((field, index) => (
        <div key={index} className="mb-2 flex items-start gap-2">
          <TextInput
            className="w-28 shrink-0"
            value={field.label}
            onChange={(event) =>
              onPatch({
                fields: entity.fields.map((candidate, position) =>
                  position === index ? { ...candidate, label: event.target.value } : candidate
                )
              })
            }
          />
          <TextInput
            value={field.value}
            onChange={(event) =>
              onPatch({
                fields: entity.fields.map((candidate, position) =>
                  position === index ? { ...candidate, value: event.target.value } : candidate
                )
              })
            }
          />
          <ToolbarButton
            label="Remove detail"
            onClick={() =>
              onPatch({ fields: entity.fields.filter((_field, position) => position !== index) })
            }
          >
            ✕
          </ToolbarButton>
        </div>
      ))}
      <div className="mb-2 flex flex-wrap gap-1">
        {unused.map((label) => (
          <ToolbarButton
            key={label}
            label={`Add ${label}`}
            onClick={() => onPatch({ fields: [...entity.fields, { label, value: '' }] })}
          >
            ＋ {label}
          </ToolbarButton>
        ))}
        <ToolbarButton
          label="Add a detail"
          onClick={() => onPatch({ fields: [...entity.fields, { label: '', value: '' }] })}
        >
          ＋ custom
        </ToolbarButton>
      </div>

      <SectionTitle>Notes</SectionTitle>
      <EntityNotes
        entityId={entity.id}
        notes={entity.notes}
        onChange={(notes) => onPatch({ notes })}
      />

      <MentionList entity={entity} />
    </div>
  )
}

/**
 * The one panel a project's whole record vocabulary shares — dockview resolves
 * `kind` from the panel's own params, set at the moment it's opened
 * (`DockRoot.tsx`'s per-kind commands).
 */
export function RecordsPanel(props: IDockviewPanelProps<{ kind: string }>) {
  return <EntityPanel kind={props.params.kind} />
}

/**
 * `characters`/`locations` were the panel's own component ids before a
 * project's record kinds became configurable. Kept only so a layout saved by
 * an older build — which stores this string, not a kind param — still
 * resolves without a `layouts.json` migration; nothing in this build opens a
 * panel through these ids going forward.
 */
export function CharactersPanel() {
  return <EntityPanel kind="character" />
}

export function LocationsPanel() {
  return <EntityPanel kind="location" />
}
