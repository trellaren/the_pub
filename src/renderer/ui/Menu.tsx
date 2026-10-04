import { useEffect, useLayoutEffect, useRef } from 'react'
import { cx } from './primitives.js'

export type MenuEntry =
  | { label: string; run: () => void; disabled?: boolean; danger?: boolean }
  | { separator: true }

/**
 * A right-click menu.
 *
 * Grown out of the file tree's private one when the Explorer's background and
 * other panels needed menus too. HTML rather than Electron's native Menu for
 * the reason the whole app prefers HTML surfaces: Playwright can click this,
 * and a native popup is invisible to it — the same argument `contract.ts`
 * makes for splitting the docx dialogs.
 */
export function ContextMenu({
  x,
  y,
  items,
  onClose
}: {
  x: number
  y: number
  items: MenuEntry[]
  onClose: () => void
}) {
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const dismiss = (): void => onClose()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    // The menu may live in a popout's document; listen where it actually is.
    const view = panel.current?.ownerDocument.defaultView ?? window
    view.addEventListener('click', dismiss)
    view.addEventListener('contextmenu', dismiss)
    view.addEventListener('keydown', onKey)
    return () => {
      view.removeEventListener('click', dismiss)
      view.removeEventListener('contextmenu', dismiss)
      view.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // Clamp into the viewport before paint: a menu opened near the bottom of the
  // tree would otherwise hang off the window, with its items unreachable.
  //
  // `fixed` is not always viewport-relative: a transformed ancestor becomes the
  // containing block, and dockview's render overlay is one. So place the menu
  // at the requested point first, measure where it actually landed, and fold
  // that offset into the clamped position rather than trusting `left`/`top`.
  useLayoutEffect(() => {
    const element = panel.current
    if (!element) return
    const view = element.ownerDocument.defaultView ?? window
    element.style.left = `${x}px`
    element.style.top = `${y}px`
    const box = element.getBoundingClientRect()
    const offsetX = box.left - x
    const offsetY = box.top - y
    const left = Math.max(0, Math.min(x, view.innerWidth - box.width))
    const top = Math.max(0, Math.min(y, view.innerHeight - box.height))
    element.style.left = `${left - offsetX}px`
    element.style.top = `${top - offsetY}px`
  }, [x, y])

  return (
    <div
      ref={panel}
      role="menu"
      data-testid="context-menu"
      style={{ left: x, top: y }}
      className="fixed z-50 min-w-40 rounded border border-border bg-surface-2 py-1 shadow-lg"
      onClick={(event) => event.stopPropagation()}
    >
      {items.map((item, index) =>
        'separator' in item ? (
          <div key={`separator-${index}`} className="my-1 border-t border-border" />
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              onClose()
              item.run()
            }}
            className={cx(
              'block w-full px-3 py-1 text-left text-[12px] hover:bg-surface-3 disabled:opacity-40 disabled:hover:bg-transparent',
              item.danger ? 'text-danger' : 'text-text'
            )}
          >
            {item.label}
          </button>
        )
      )}
    </div>
  )
}
