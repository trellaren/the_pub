import type { FocusEvent, KeyboardEvent } from 'react'

/**
 * Keyboard movement for a `role="tree"` container, per the ARIA tree pattern:
 * Up/Down step through visible rows, Home/End jump to the ends. Rows keep a
 * roving tab stop — the selected one renders `tabIndex={0}`, and moving focus
 * hands the stop along — so the tree is one Tab stop rather than one per row.
 * Focus moves without selecting: Enter on a focused row acts on it while the
 * selection (where New Document lands) stays put. Left/Right
 * (collapse/expand) stay with each row, which knows whether it can.
 *
 * Works on the rendered `[role="treeitem"]` elements, so it needs no model of
 * either tree's nesting and stays right however rows are filtered or folded.
 */
export function handleTreeKeyDown(event: KeyboardEvent<HTMLElement>): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const items = treeItems(event.currentTarget)
  if (items.length === 0) return
  const current = items.indexOf(event.target as HTMLElement)
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : current === -1
          ? 0
          : Math.min(Math.max(current + (event.key === 'ArrowDown' ? 1 : -1), 0), items.length - 1)
  event.preventDefault()
  focusItem(items, next)
}

/**
 * When Tab lands on the tree itself — nothing is selected yet, so no row holds
 * the tab stop — hand focus to the first row. Only when arriving from outside:
 * Shift+Tab out of a row passes through the container on its way past.
 */
export function handleTreeFocus(event: FocusEvent<HTMLElement>): void {
  if (event.target !== event.currentTarget) return
  if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
  const tree = event.currentTarget
  // After the focus event finishes: moving focus from inside its own handler
  // is undone by the browser completing the original focus.
  queueMicrotask(() => {
    if (tree.ownerDocument.activeElement === tree) focusItem(treeItems(tree), 0)
  })
}

function treeItems(tree: HTMLElement): HTMLElement[] {
  return Array.from(tree.querySelectorAll<HTMLElement>('[role="treeitem"]'))
}

function focusItem(items: HTMLElement[], index: number): void {
  const item = items[index]
  if (!item) return
  for (const other of items) other.tabIndex = other === item ? 0 : -1
  item.focus()
}
