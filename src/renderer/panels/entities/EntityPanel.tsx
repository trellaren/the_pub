import { useMemo, useState } from 'react'
import type { EntityKind, StoryEntity } from '@shared/model/entity.js'
import { SUGGESTED_FIELDS } from '@shared/model/entity.js'
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
import { MentionList } from './MentionList.js'
import { EntityNotes } from './EntityNotes.js'

const LABELS: Record<EntityKind, { title: string; singular: string }> = {
  character: { title: 'Characters', singular: 'character' },
  location: { title: 'Locations', singular: 'location' }
}

/**
 * Master/detail editor for story records, in StylesPanel's shape.
 *
 * One component for both kinds: characters and locations differ only in the
 * field labels offered, so a second implementation would be the same code with
 * a different noun in it, drifting from this one within a release.
 */
export function EntityPanel({ kind }: { kind: EntityKind }) {
  const project = useProjectStore((store) => store.project)
  // Select the stable array and narrow it in a memo. Selecting
  // `entities.filter(...)` would return a fresh array on every render, which is
  // the infinite-loop this codebase has already been bitten by under zustand v5.
  const entities = useEntityStore((store) => store.entities)
  const counts = useEntityStore((store) => store.counts)
  const patch = useEntityStore((store) => store.patch)
  const create = useEntityStore((store) => store.create)
  const remove = useEntityStore((store) => store.remove)

  const mine = useMemo(() => entities.filter((entity) => entity.kind === kind), [entities, kind])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = mine.find((entity) => entity.id === selectedId) ?? mine[0] ?? null
  const labels = LABELS[kind]

  const addRecord = async (): Promise<void> => {
    const name = window.prompt(`New ${labels.singular} name`)
    if (!name?.trim()) return
    const entity = await create(kind, name.trim())
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
        <PanelHeader>{labels.title}</PanelHeader>
        <EmptyState title="No project open" />
      </PanelShell>
    )
  }

  return (
    <PanelShell>
      <PanelHeader>
        <span className="flex-1">{labels.title}</span>
        <ToolbarButton label={`New ${labels.singular}`} onClick={() => void addRecord()}>
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
          <EntityDetail entity={selected} onPatch={(changes) => patch(selected.id, changes)} />
        ) : (
          <EmptyState
            title={`No ${labels.title.toLowerCase()} yet`}
            hint={`Add one, then type its name — or @-mention it — in a document.`}
          />
        )}
      </div>
    </PanelShell>
  )
}

function EntityDetail({
  entity,
  onPatch
}: {
  entity: StoryEntity
  onPatch: (changes: Partial<StoryEntity>) => void
}) {
  const suggestions = SUGGESTED_FIELDS[entity.kind]
  const used = new Set(entity.fields.map((field) => field.label))
  const unused = suggestions.filter((label) => !used.has(label))

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

export function CharactersPanel() {
  return <EntityPanel kind="character" />
}

export function LocationsPanel() {
  return <EntityPanel kind="location" />
}
