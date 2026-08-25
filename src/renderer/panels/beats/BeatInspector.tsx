import type { Beat, BoardColumn } from '@shared/model/beat.js'
import { beatStatuses } from '@shared/model/beat.js'
import type { StoryEntity } from '@shared/model/entity.js'
import {
  Field,
  TextInput,
  TextArea,
  Select,
  ToolbarButton,
  SectionTitle,
  cx
} from '@renderer/ui/primitives.js'
import { openBeatScene, currentSceneLocation } from './beatScene.js'

/**
 * The editor for one beat, shared by both views.
 *
 * Everything here writes straight through to the debounced store, the same
 * pattern the style and record panels use.
 */
export function BeatInspector({
  beat,
  columns,
  entities,
  onPatch,
  onDelete
}: {
  beat: Beat
  columns: BoardColumn[]
  entities: StoryEntity[]
  onPatch: (changes: Partial<Beat>) => void
  onDelete: () => void
}) {
  const linkScene = (): void => {
    const location = currentSceneLocation()
    // Nothing is open, or the caret is not in an editor: leave the link alone
    // rather than clearing one the author set earlier.
    if (!location) return
    onPatch({ docId: location.docId, blockIndex: location.blockIndex })
  }

  return (
    <div className="min-w-0 flex-1 overflow-y-auto border-l border-border p-3" data-testid="beat-inspector">
      <Field label="Title">
        <TextInput
          value={beat.title}
          onChange={(event) => onPatch({ title: event.target.value })}
          data-testid="beat-title"
        />
      </Field>

      <Field label="When (in the story)">
        <TextInput
          value={beat.when.label}
          placeholder="Day 3, Third Age 2941, 1917-04-02…"
          onChange={(event) => onPatch({ when: { ...beat.when, label: event.target.value } })}
          data-testid="beat-when"
        />
      </Field>
      <p className="mb-2 -mt-1 text-[10px] text-faint">
        {beat.when.sort === null
          ? 'Not dated — drag it on the timeline to place it.'
          : 'Dated, so the timeline orders it for you.'}
      </p>

      <Field label="Summary">
        <TextArea
          rows={3}
          value={beat.summary}
          placeholder="What happens, in a line or two."
          onChange={(event) => onPatch({ summary: event.target.value })}
        />
      </Field>

      <div className="mb-2 flex gap-2">
        <Field label="Status">
          <Select
            value={beat.status}
            onChange={(event) => onPatch({ status: event.target.value as Beat['status'] })}
          >
            {beatStatuses.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Column">
          <Select
            value={beat.columnId}
            onChange={(event) => onPatch({ columnId: event.target.value })}
          >
            {columns.map((column) => (
              <option key={column.id} value={column.id}>
                {column.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <SectionTitle>Scene</SectionTitle>
      <div className="mb-2 flex flex-wrap gap-1">
        <ToolbarButton label="Link this beat to the paragraph the caret is in" onClick={linkScene}>
          link to caret
        </ToolbarButton>
        <ToolbarButton
          label="Open the linked scene"
          disabled={!beat.docId}
          onClick={() => void openBeatScene(beat)}
        >
          open scene
        </ToolbarButton>
        {beat.docId ? (
          <ToolbarButton
            label="Unlink the scene"
            onClick={() => onPatch({ docId: null, blockIndex: null })}
          >
            unlink
          </ToolbarButton>
        ) : null}
      </div>

      <SectionTitle>Who and where</SectionTitle>
      {entities.length === 0 ? (
        <p className="text-[11px] text-faint">No characters or locations yet.</p>
      ) : (
        <div className="flex flex-wrap gap-1">
          {entities.map((entity) => {
            const on = beat.entityIds.includes(entity.id)
            return (
              <button
                key={entity.id}
                type="button"
                onClick={() =>
                  onPatch({
                    entityIds: on
                      ? beat.entityIds.filter((id) => id !== entity.id)
                      : [...beat.entityIds, entity.id]
                  })
                }
                className={cx(
                  'rounded-full border px-2 py-px text-[11px]',
                  on ? 'border-accent text-text' : 'border-border text-muted hover:border-faint',
                  // A draft is castable — trying it in a scene is how the writer
                  // judges it — but it must not blend in with accepted records.
                  entity.provisional && 'italic'
                )}
                style={on ? { background: `${entity.color ?? '#7aa2f7'}22` } : undefined}
                title={entity.provisional ? 'Drafted by the assistant — not yet accepted' : undefined}
              >
                {entity.name}
              </button>
            )
          })}
        </div>
      )}

      <SectionTitle>Colour</SectionTitle>
      <div className="mb-3 flex items-center gap-2">
        <input
          type="color"
          value={beat.color ?? '#7aa2f7'}
          onChange={(event) => onPatch({ color: event.target.value })}
          className="pub-focus-ring h-7 w-10 cursor-pointer rounded border border-border bg-surface-2"
        />
        {beat.color ? (
          <ToolbarButton label="Clear colour" onClick={() => onPatch({ color: undefined })}>
            clear
          </ToolbarButton>
        ) : null}
      </div>

      <ToolbarButton label="Delete beat" className="text-danger" onClick={onDelete}>
        Delete beat
      </ToolbarButton>
    </div>
  )
}
