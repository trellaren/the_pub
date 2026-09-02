import { useEffect, useRef, useState } from 'react'
import { resolveMenu, type MenuNode } from '@shared/menu/menuModel.js'
import { acceleratorLabel } from '@shared/menu/keybindings.js'
import { ROLE_ITEMS, type MenuItemRole } from '@shared/menu/menuRoles.js'
import { useAppStore } from '@renderer/stores/appStore.js'
import { runCommand } from '@renderer/commands/registry.js'
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
  const bar = useRef<HTMLDivElement>(null)

  const menus = resolveMenu('other', overrides).flatMap((entry) =>
    entry.kind === 'menu' ? [entry] : []
  )

  useEffect(() => {
    if (!openMenu) return
    const dismiss = (event: MouseEvent): void => {
      if (!bar.current?.contains(event.target as Node)) setOpenMenu(null)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpenMenu(null)
    }
    window.addEventListener('mousedown', dismiss)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', dismiss)
      window.removeEventListener('keydown', onKey)
    }
  }, [openMenu])

  return (
    <div ref={bar} role="menubar" className="pub-no-drag flex items-center" data-testid="menu-bar">
      {menus.map((menu) => (
        // `role="none"`: a menubar's children have to be its menu items, and a
        // positioning wrapper that says nothing about itself is read as one.
        <div key={menu.label} role="none" className="relative">
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={openMenu === menu.label}
            data-testid={`menu-${menu.label.toLowerCase()}`}
            // Hovering moves between open menus, the way a menu bar does
            // everywhere — but only once one is open, or passing the mouse over
            // the bar on the way somewhere else would drop a menu on the app.
            onMouseEnter={() => setOpenMenu((current) => (current === null ? null : menu.label))}
            onClick={() => setOpenMenu((current) => (current === menu.label ? null : menu.label))}
            className={cx(
              'h-full px-2 py-1 text-[12px] text-muted hover:bg-surface-3 hover:text-text',
              openMenu === menu.label && 'bg-surface-3 text-text'
            )}
          >
            {menu.label}
          </button>
          {openMenu === menu.label ? (
            <MenuList items={menu.items} onClose={() => setOpenMenu(null)} />
          ) : null}
        </div>
      ))}
    </div>
  )
}

const EMPTY_OVERRIDES = {}

function MenuList({ items, onClose }: { items: MenuNode[]; onClose: () => void }): React.JSX.Element {
  return (
    <div
      role="menu"
      data-testid="menu-dropdown"
      className="absolute left-0 top-full z-50 min-w-64 rounded-b border border-border bg-surface-2 py-1 shadow-lg"
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

  if (item.kind === 'separator') return <div className="my-1 border-t border-border" />

  if (item.kind === 'submenu') {
    return (
      <div
        role="none"
        className="relative"
        onMouseEnter={() => setOpenSub(true)}
        onMouseLeave={() => setOpenSub(false)}
      >
        <Row label={item.label} trailing="›" onSelect={() => setOpenSub((open) => !open)} expanded={openSub} />
        {openSub ? (
          <div
            role="menu"
            className="absolute left-full top-0 z-50 max-h-[70vh] min-w-56 overflow-y-auto rounded border border-border bg-surface-2 py-1 shadow-lg"
          >
            {item.items.map((child, index) => (
              <MenuRow key={rowKey(child, index)} item={child} onClose={onClose} />
            ))}
          </div>
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
        } else if (!runCommand(item.commandId)) {
          reportError(`Nothing handles the command "${item.commandId}"`)
        }
      }}
    />
  )
}

function Row({
  label,
  trailing,
  onSelect,
  expanded,
  testId
}: {
  label: string
  trailing?: string
  onSelect: () => void
  expanded?: boolean
  testId?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      aria-expanded={expanded}
      // Keeping focus where it was is what lets Cut, Copy and Paste act on the
      // editor's selection: a menu that takes focus to be clicked has already
      // destroyed the thing those items operate on.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onSelect}
      className="flex w-full items-center gap-6 px-3 py-1 text-left text-[12px] text-text hover:bg-surface-3"
    >
      <span className="flex-1 truncate">{label}</span>
      {trailing ? <span className="shrink-0 text-[11px] text-faint">{trailing}</span> : null}
    </button>
  )
}
