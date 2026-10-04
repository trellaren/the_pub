import { useEffect, useRef, useState } from 'react'
import { resolveMenu, type MenuNode } from '@shared/menu/menuModel.js'
import { acceleratorLabel } from '@shared/menu/keybindings.js'
import { ROLE_ITEMS, type MenuItemRole } from '@shared/menu/menuRoles.js'
import { useAppStore } from '@renderer/stores/appStore.js'
import { isRegistered, runCommand } from '@renderer/commands/registry.js'
import { invoke, reportError } from '@renderer/lib/ipc.js'
import { cx } from '@renderer/ui/primitives.js'

/**
 * The File / Edit / View menus, drawn in the title bar.
 *
 * Only where the window has no frame to hang a native menu bar on — macOS keeps
 * its menus in the system bar, and this renders nothing there. It is the same
 * `MENU_MODEL` the native menu is built from, so the two cannot disagree about
 * what the app can do; what differs is only who draws it.
 *
 * The native menu is still registered in main. That is what makes the
 * accelerators work, and what the keybindings editor is written against — this
 * bar is a second *view* of that model, never a second copy of it.
 */
export function MenuBar(): React.JSX.Element {
  const overrides = useAppStore((store) => store.state?.keybindings) ?? EMPTY_OVERRIDES
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  /** Which top-level item holds the bar's single Tab stop. */
  const [current, setCurrent] = useState(0)
  /** Whether the open menu was opened from the keyboard, and so should take focus. */
  const [focusMenu, setFocusMenu] = useState(false)
  const bar = useRef<HTMLDivElement>(null)
  // Where focus was before the keyboard brought it to the bar — usually the
  // editor, whose selection Cut, Copy and Paste have to act on.
  const returnFocus = useRef<HTMLElement | null>(null)

  const menus = resolveMenu('other', overrides).flatMap((entry) =>
    entry.kind === 'menu' ? [entry] : []
  )

  const topItems = (): HTMLElement[] =>
    Array.from(bar.current?.querySelectorAll<HTMLElement>(':scope > [role="none"] > [role="menuitem"]') ?? [])

  const focusTop = (index: number): void => {
    const wrapped = (index + menus.length) % menus.length
    setCurrent(wrapped)
    topItems()[wrapped]?.focus()
  }

  const leave = (): void => {
    setOpenMenu(null)
    const target = returnFocus.current
    returnFocus.current = null
    if (target && target.isConnected) target.focus()
    else (document.activeElement as HTMLElement | null)?.blur()
  }

  const closeMenu = (): void => {
    if (returnFocus.current) leave()
    else setOpenMenu(null)
  }

  useEffect(() => {
    // Alt on its own or F10 moves to the bar, as in every Windows and Linux app.
    let altAlone = false
    const enterBar = (): void => {
      if (!bar.current || bar.current.contains(document.activeElement)) return
      returnFocus.current = document.activeElement as HTMLElement | null
      setCurrent(0)
      topItems()[0]?.focus()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      altAlone = event.key === 'Alt' && !event.ctrlKey && !event.metaKey && !event.shiftKey
      if (event.key === 'F10' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        event.preventDefault()
        enterBar()
      }
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key === 'Alt' && altAlone) {
        event.preventDefault()
        if (bar.current?.contains(document.activeElement)) leave()
        else enterBar()
      }
      altAlone = false
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  useEffect(() => {
    if (!openMenu) return
    const dismiss = (event: MouseEvent): void => {
      if (!bar.current?.contains(event.target as Node)) setOpenMenu(null)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !bar.current?.contains(document.activeElement)) setOpenMenu(null)
    }
    window.addEventListener('mousedown', dismiss)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', dismiss)
      window.removeEventListener('keydown', onKey)
    }
  }, [openMenu])

  const openFromKeyboard = (index: number): void => {
    const wrapped = (index + menus.length) % menus.length
    if (!returnFocus.current && !bar.current?.contains(document.activeElement)) {
      returnFocus.current = document.activeElement as HTMLElement | null
    }
    setCurrent(wrapped)
    setFocusMenu(true)
    setOpenMenu(menus[wrapped]!.label)
    topItems()[wrapped]?.focus()
  }

  const onTopKeyDown = (event: React.KeyboardEvent, index: number): void => {
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault()
        if (openMenu) openFromKeyboard(index + 1)
        else focusTop(index + 1)
        break
      case 'ArrowLeft':
        event.preventDefault()
        if (openMenu) openFromKeyboard(index - 1)
        else focusTop(index - 1)
        break
      case 'Home':
        event.preventDefault()
        focusTop(0)
        break
      case 'End':
        event.preventDefault()
        focusTop(menus.length - 1)
        break
      case 'ArrowDown':
      case 'ArrowUp':
      case 'Enter':
      case ' ':
        event.preventDefault()
        openFromKeyboard(index)
        break
      case 'Escape':
        event.preventDefault()
        if (openMenu) setOpenMenu(null)
        else leave()
        break
    }
  }

  return (
    <div ref={bar} role="menubar" className="pub-no-drag flex items-center" data-testid="menu-bar">
      {menus.map((menu, index) => (
        // `role="none"`: a menubar's children have to be its menu items, and a
        // positioning wrapper that says nothing about itself is read as one.
        <div key={menu.label} role="none" className="relative">
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={openMenu === menu.label}
            tabIndex={index === current ? 0 : -1}
            data-testid={`menu-${menu.label.toLowerCase()}`}
            // Hovering moves between open menus, the way a menu bar does
            // everywhere — but only once one is open, or passing the mouse over
            // the bar on the way somewhere else would drop a menu on the app.
            onMouseEnter={() => setOpenMenu((open) => (open === null ? null : menu.label))}
            onClick={(event) => {
              // A click synthesised from Enter or Space was already handled on keydown.
              if (event.detail === 0) return
              setFocusMenu(false)
              setOpenMenu((open) => (open === menu.label ? null : menu.label))
            }}
            onKeyDown={(event) => onTopKeyDown(event, index)}
            className={cx(
              'pub-focus-ring h-full px-2 py-1 text-[12px] text-muted hover:bg-surface-3 hover:text-text',
              openMenu === menu.label && 'bg-surface-3 text-text'
            )}
          >
            {menu.label}
          </button>
          {openMenu === menu.label ? (
            <MenuList
              items={menu.items}
              autoFocus={focusMenu}
              onClose={closeMenu}
              onEscape={() => {
                setOpenMenu(null)
                focusTop(index)
              }}
              onNeighbour={(step) => openFromKeyboard(index + step)}
            />
          ) : null}
        </div>
      ))}
    </div>
  )
}

const EMPTY_OVERRIDES = {}

interface MenuListProps {
  items: MenuNode[]
  autoFocus: boolean
  onClose: () => void
  onEscape: () => void
  onNeighbour: (step: 1 | -1) => void
  className?: string
}

/**
 * One open menu's keyboard handling: Up/Down/Home/End walk its items, Right
 * opens a submenu or moves to the next top-level menu, Left closes back out.
 */
function MenuList({ items, autoFocus, onClose, onEscape, onNeighbour, className }: MenuListProps): React.JSX.Element {
  const list = useRef<HTMLDivElement>(null)
  const own = (): HTMLElement[] =>
    Array.from(
      list.current?.querySelectorAll<HTMLElement>(
        ':scope > [role="menuitem"], :scope > [role="none"] > [role="menuitem"]'
      ) ?? []
    )

  useEffect(() => {
    if (autoFocus) own()[0]?.focus()
  }, [autoFocus])

  const onKeyDown = (event: React.KeyboardEvent): void => {
    const rows = own()
    const at = rows.indexOf(document.activeElement as HTMLElement)
    if (at === -1) return
    const handled = (): void => {
      event.preventDefault()
      event.stopPropagation()
    }
    switch (event.key) {
      case 'ArrowDown':
        handled()
        return rows[(at + 1) % rows.length]?.focus()
      case 'ArrowUp':
        handled()
        return rows[(at - 1 + rows.length) % rows.length]?.focus()
      case 'Home':
        handled()
        return rows[0]?.focus()
      case 'End':
        handled()
        return rows[rows.length - 1]?.focus()
      case 'ArrowRight':
        if (rows[at]?.getAttribute('aria-haspopup')) return
        handled()
        return onNeighbour(1)
      case 'ArrowLeft':
        handled()
        return onNeighbour(-1)
      case 'Escape':
        handled()
        return onEscape()
    }
  }

  return (
    <div
      ref={list}
      role="menu"
      data-testid="menu-dropdown"
      onKeyDown={onKeyDown}
      className={
        className ?? 'absolute left-0 top-full z-50 min-w-64 rounded-b border border-border bg-surface-2 py-1 shadow-lg'
      }
    >
      {items.map((item, index) => (
        <MenuRow key={rowKey(item, index)} item={item} onClose={onClose} />
      ))}
    </div>
  )
}

function rowKey(item: MenuNode, index: number): string {
  if (item.kind === 'separator') return `separator-${index}`
  if (item.kind === 'role') return item.role
  return item.kind === 'command' ? item.commandId : item.label
}

function MenuRow({ item, onClose }: { item: MenuNode; onClose: () => void }): React.JSX.Element | null {
  const platform = useAppStore((store) => store.state?.platform) ?? ''
  const [openSub, setOpenSub] = useState(false)
  const [subFromKeyboard, setSubFromKeyboard] = useState(false)
  const trigger = useRef<HTMLDivElement>(null)

  if (item.kind === 'separator') return <div className="my-1 border-t border-border" />

  if (item.kind === 'submenu') {
    const closeSub = (): void => {
      setOpenSub(false)
      trigger.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    }
    return (
      <div
        ref={trigger}
        role="none"
        className="relative"
        onMouseEnter={() => {
          setSubFromKeyboard(false)
          setOpenSub(true)
        }}
        onMouseLeave={() => setOpenSub(false)}
        onKeyDown={(event) => {
          if (event.target !== trigger.current?.firstElementChild) return
          if (event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            event.stopPropagation()
            setSubFromKeyboard(true)
            setOpenSub(true)
          }
        }}
      >
        <Row
          label={item.label}
          trailing="›"
          onSelect={() => setOpenSub((open) => !open)}
          expanded={openSub}
          hasPopup
        />
        {openSub ? (
          <SubmenuList items={item.items} autoFocus={subFromKeyboard} onClose={onClose} onBack={closeSub} />
        ) : null}
      </div>
    )
  }

  if (item.kind === 'role') {
    // A role the table does not name would render as an unlabelled row, which
    // is worse than not offering it; `menuRoles.test.ts` keeps this unreachable.
    if (!(item.role in ROLE_ITEMS)) return null
    const role = item.role as MenuItemRole
    return (
      <Row
        label={ROLE_ITEMS[role].label}
        trailing={
          ROLE_ITEMS[role].accelerator
            ? acceleratorLabel(ROLE_ITEMS[role].accelerator, platform)
            : undefined
        }
        onSelect={() => {
          onClose()
          void invoke('window:menuRole', { role })
        }}
      />
    )
  }

  return (
    <Row
      // `resolveMenu` has already put the person's own shortcut on the item, so
      // a rebinding shows here for the same reason it shows in the native menu.
      label={item.label}
      trailing={item.accelerator ? acceleratorLabel(item.accelerator, platform) : undefined}
      testId={`menu-item-${item.commandId}`}
      onSelect={() => {
        onClose()
        // `target: 'main'` marks the handful no renderer can run — opening a
        // window when there may not be one. There is one, and it has a channel
        // of its own; anything else so marked is a wiring bug worth saying out
        // loud rather than a silently dead menu item.
        if (item.target === 'main') {
          if (item.commandId === 'window.new') void invoke('window:newProject', {})
          else reportError(`Nothing handles the command "${item.commandId}"`)
        } else if (!runCommand(item.commandId) && !isRegistered(item.commandId)) {
          reportError(`Nothing handles the command "${item.commandId}"`)
        }
      }}
    />
  )
}

function SubmenuList({
  items,
  autoFocus,
  onClose,
  onBack
}: {
  items: MenuNode[]
  autoFocus: boolean
  onClose: () => void
  onBack: () => void
}): React.JSX.Element {
  return (
    <MenuList
      items={items}
      autoFocus={autoFocus}
      onClose={onClose}
      onEscape={onBack}
      onNeighbour={(step) => {
        if (step === -1) onBack()
      }}
      className="absolute left-full top-0 z-50 max-h-[70vh] min-w-56 overflow-y-auto rounded border border-border bg-surface-2 py-1 shadow-lg"
    />
  )
}

function Row({
  label,
  trailing,
  onSelect,
  expanded,
  hasPopup,
  testId
}: {
  label: string
  trailing?: string
  onSelect: () => void
  expanded?: boolean
  hasPopup?: boolean
  testId?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      aria-expanded={expanded}
      aria-haspopup={hasPopup ? 'menu' : undefined}
      tabIndex={-1}
      // Keeping focus where it was is what lets Cut, Copy and Paste act on the
      // editor's selection: a menu that takes focus to be clicked has already
      // destroyed the thing those items operate on.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onSelect}
      className="flex w-full items-center gap-6 px-3 py-1 text-left text-[12px] text-text outline-none hover:bg-surface-3 focus:bg-surface-3"
    >
      <span className="flex-1 truncate">{label}</span>
      {trailing ? <span className="shrink-0 text-[11px] text-faint">{trailing}</span> : null}
    </button>
  )
}
