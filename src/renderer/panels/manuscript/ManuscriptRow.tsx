import type { DragEvent } from 'react'
import { partRoles, type PartRole, type ResolvedNode } from '@shared/model/manuscript.js'
import { Select, cx } from '@renderer/ui/primitives.js'
import type { Move } from './dropTarget.js'

const ROLE_LABEL: Record<PartRole, string> = { front: 'Front matter', body: 'Body', back: 'Back matter' }

/** One row: a part or a document, resolved against the index. */
export function ManuscriptNodeRow({
  node,
  depth,
  expanded,
  selected,
  dragging,
  insideTarget,
  words,
  missing,
  onToggle,
  onSelect,
  onActivate,
  onRename,
  onSetRole,
  onAddInto,
  onRelink,
  onRemove,
  onMove,
  canMove,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onContextMenu
}: {
  node: ResolvedNode
  depth: 0 | 1
  expanded: boolean
  selected: boolean
  dragging: boolean
  /** This part is where a drop-in-progress would land. Highlighted, no rule anywhere. */
  insideTarget: boolean
  words: number
  missing: boolean
  onToggle: () => void
  onSelect: () => void
  onActivate: () => void
  onRename: (title: string, owner?: Document) => void
  onSetRole: (role: PartRole) => void
  onAddInto: () => void
  onRelink: () => void
  onRemove: () => void
  onMove: (move: Move) => void
  canMove: (move: Move) => boolean
  onDragStart: (event: DragEvent) => void
  onDragOver: (event: DragEvent) => void
  onDrop: (event: DragEvent) => void
  onDragEnd: () => void
  onContextMenu: (event: React.MouseEvent) => void
}) {
  const isPart = node.kind === 'part'

  return (
    <div
      role="treeitem"
      data-testid={isPart ? 'manuscript-part' : 'manuscript-document'}
      data-node-id={node.id}
      aria-label={node.title}
      aria-expanded={isPart ? expanded : undefined}
      aria-selected={selected}
      tabIndex={0}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onClick={() => {
        onSelect()
        if (isPart) onToggle()
        else onActivate()
      }}
      onDoubleClick={(event) => isPart && onRename(node.title, event.currentTarget.ownerDocument)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !isPart) onActivate()
        if (event.key === 'F2') onRename(node.title, event.currentTarget.ownerDocument)
      }}
      onContextMenu={onContextMenu}
      style={{ paddingLeft: 6 + depth * 12 }}
      className={cx(
        'pub-focus-ring flex h-[22px] shrink-0 cursor-default select-none items-center gap-1 pr-1 text-[12px]',
        dragging && 'opacity-40',
        insideTarget && 'bg-accent-soft ring-1 ring-inset ring-accent',
        !insideTarget && (selected ? 'bg-surface-3 text-text' : 'text-muted hover:bg-surface-2')
      )}
    >
      <span className="w-3 shrink-0 text-center text-[9px] text-faint">
        {isPart ? (expanded ? '▾' : '▸') : ''}
      </span>
      <span
        className={cx('truncate', !isPart && 'text-text', missing && 'text-danger line-through')}
        title={node.resolvedPath ?? undefined}
      >
        {node.title || (isPart ? 'Untitled part' : 'Untitled')}
      </span>
      {missing ? (
        <span data-testid="manuscript-missing" className="shrink-0 text-[10px] text-danger">
          Missing
        </span>
      ) : null}
      {isPart ? (
        <Select
          aria-label="Part role"
          value={node.role}
          className="h-5 shrink-0 text-[10px]"
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => onSetRole(event.target.value as PartRole)}
        >
          {partRoles.map((role) => (
            <option key={role} value={role}>
              {ROLE_LABEL[role]}
            </option>
          ))}
        </Select>
      ) : null}
      <span className="shrink-0 text-[10px] text-faint">{words.toLocaleString()}w</span>

      <RowButton label="Move up" glyph="▲" disabled={!canMove('up')} onClick={() => onMove('up')} />
      <RowButton label="Move down" glyph="▼" disabled={!canMove('down')} onClick={() => onMove('down')} />
      {!isPart ? (
        <RowButton
          label="Indent into part above"
          glyph="→"
          disabled={!canMove('indent')}
          onClick={() => onMove('indent')}
        />
      ) : null}
      {!isPart ? (
        <RowButton
          label="Outdent to top level"
          glyph="←"
          disabled={!canMove('outdent')}
          onClick={() => onMove('outdent')}
        />
      ) : null}
      {isPart ? <RowButton label="Add documents here" glyph="＋" onClick={onAddInto} /> : null}
      {missing ? <RowButton label="Relink…" glyph="⛓" onClick={onRelink} /> : null}
      <RowButton label={isPart ? 'Remove part' : 'Remove from book'} glyph="✕" onClick={onRemove} />
    </div>
  )
}

/** A drop target for an empty, expanded part — a real row, not a hoped-for gap. */
export function ManuscriptPlaceholderRow({
  insideTarget,
  onDragOver,
  onDrop
}: {
  insideTarget: boolean
  onDragOver: (event: DragEvent) => void
  onDrop: (event: DragEvent) => void
}) {
  return (
    <div
      data-testid="manuscript-placeholder"
      onDragOver={onDragOver}
      onDrop={onDrop}
      style={{ paddingLeft: 6 + 12 }}
      className={cx(
        'flex h-[22px] shrink-0 select-none items-center text-[11px] italic text-faint',
        insideTarget && 'bg-accent-soft ring-1 ring-inset ring-accent'
      )}
    >
      Drop chapters here
    </div>
  )
}

function RowButton({
  label,
  glyph,
  disabled,
  onClick
}: {
  label: string
  glyph: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      className="pub-focus-ring flex h-4 w-4 shrink-0 items-center justify-center rounded text-[9px] text-faint hover:bg-surface-3 hover:text-text disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {glyph}
    </button>
  )
}
