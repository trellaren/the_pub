import type { Beat, BeatStatus } from '@shared/model/beat.js'
import type { StoryEntity } from '@shared/model/entity.js'
import { cx } from '@renderer/ui/primitives.js'

const STATUS_LABEL: Record<BeatStatus, string> = {
  outline: 'Outline',
  draft: 'Draft',
  revised: 'Revised',
  done: 'Done'
}

const STATUS_CLASS: Record<BeatStatus, string> = {
  outline: 'text-faint',
  draft: 'text-muted',
  revised: 'text-accent',
  done: 'text-accent'
}

/**
 * One beat, as it appears in both views.
 *
 * The timeline and the board show the same card so a beat is recognisable when
 * an author switches between them — the two views differ in how cards are
 * *ordered*, and nothing else.
 */
export function BeatCard({
  beat,
  entities,
  selected,
  draggable,
  onSelect,
  onOpen,
  onDragStart
}: {
  beat: Beat
  entities: StoryEntity[]
  selected: boolean
  draggable?: boolean
  onSelect: () => void
  onOpen?: () => void
  onDragStart?: (event: React.DragEvent) => void
}) {
  const linked = entities.filter((entity) => beat.entityIds.includes(entity.id))

  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      onClick={onSelect}
      onDoubleClick={onOpen}
      data-testid="beat-card"
      data-beat-id={beat.id}
      className={cx(
        'cursor-pointer rounded border px-2 py-1.5 text-left',
        selected ? 'border-accent bg-surface-3' : 'border-border bg-surface-2 hover:border-faint'
      )}
      style={beat.color ? { borderLeft: `3px solid ${beat.color}` } : undefined}
    >
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-[12px] text-text">{beat.title}</span>
        <span className={cx('shrink-0 text-[10px]', STATUS_CLASS[beat.status])}>
          {STATUS_LABEL[beat.status]}
        </span>
      </div>

      {beat.when.label ? (
        <div className="mt-0.5 text-[10px] text-faint">{beat.when.label}</div>
      ) : null}

      {beat.summary ? (
        <p className="mt-1 line-clamp-2 text-[11px] text-muted">{beat.summary}</p>
      ) : null}

      {linked.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {linked.map((entity) => (
            <span
              key={entity.id}
              className="rounded-full px-1.5 py-px text-[10px] text-muted"
              style={{ background: `${entity.color ?? '#7aa2f7'}22` }}
            >
              {entity.name}
            </span>
          ))}
        </div>
      ) : null}

      {beat.docId ? (
        <div className="mt-1 text-[10px] text-faint" title="Double-click to open the scene">
          ↗ scene
        </div>
      ) : null}
    </div>
  )
}
