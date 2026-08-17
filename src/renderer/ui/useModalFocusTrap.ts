import { useEffect, type RefObject } from 'react'

const FOCUSABLE_SELECTOR =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'

/**
 * Traps Tab/Shift-Tab inside a modal's container while it is mounted, and
 * restores focus to whatever had it beforehand once the modal unmounts.
 *
 * Every dialog in this app (`PromptDialog`, `NewProjectDialog`,
 * `ConnectDialog`, `SaveAsTemplateDialog`, `NewMapDialog`) is a plain
 * `createPortal`/conditionally-rendered `<div>` with no shared wrapper
 * component, so this is a hook rather than a `<Modal>` — one call per
 * dialog's root element does the same job without inventing a wrapper none of
 * them currently uses.
 *
 * Reads `container.ownerDocument` rather than the module-level `document`
 * so a dialog portalled into a popped-out window (see `PromptDialog`'s
 * `ownerDocument` option) traps and restores focus in that window, not the
 * opener's.
 */
export function useModalFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  onEscape?: () => void
): void {
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const ownerDocument = container.ownerDocument
    const previouslyFocused = ownerDocument.activeElement as HTMLElement | null

    const focusables = (): HTMLElement[] =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => el.getClientRects().length > 0
      )

    // Something inside may already have focus — an `autoFocus` input runs
    // before this effect — so only move focus in when nothing has claimed it.
    if (!container.contains(ownerDocument.activeElement)) {
      const first = focusables()[0]
      if (first) {
        first.focus()
      } else {
        container.tabIndex = -1
        container.focus()
      }
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && onEscape) {
        onEscape()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) {
        event.preventDefault()
        return
      }
      const first = items[0]!
      const last = items[items.length - 1]!
      const active = ownerDocument.activeElement
      if (event.shiftKey) {
        if (active === first || !container.contains(active)) {
          event.preventDefault()
          last.focus()
        }
      } else if (active === last || !container.contains(active)) {
        event.preventDefault()
        first.focus()
      }
    }

    container.addEventListener('keydown', onKeyDown)
    return () => {
      container.removeEventListener('keydown', onKeyDown)
      // The element that had focus before the dialog opened may itself have
      // unmounted (closing a panel that also opened a dialog) — checking it
      // is still attached is what makes this safe to call unconditionally.
      if (previouslyFocused && ownerDocument.contains(previouslyFocused)) previouslyFocused.focus()
    }
  }, [containerRef, onEscape])
}
