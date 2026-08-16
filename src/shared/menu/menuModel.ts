import { THEMES } from '../themes.js'
import type { CommandBinding, KeybindingOverrides } from './keybindings.js'
import { resolveAccelerator } from './keybindings.js'

/**
 * The native menu, as data.
 *
 * It used to be a single function in main that built an Electron template
 * inline, which made two things impossible: listing what is bindable (the
 * keybindings editor needs every command and its default shortcut) and testing
 * the tree at all, since `Menu.buildFromTemplate` only exists in a running
 * Electron main process. Both fall out of the menu being a value.
 *
 * `main/menu.ts` is now only the translation into Electron's own template
 * shape, which is why nothing here imports Electron — the renderer reads this
 * same model to populate Settings.
 */
export type MenuPlatform = 'mac' | 'other'

/**
 * The subset of Electron's built-in roles this menu uses. Spelled out rather
 * than borrowed from Electron's types so this module stays importable from the
 * renderer.
 */
export type MenuRole =
  | 'appMenu'
  | 'close'
  | 'quit'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'selectAll'
  | 'toggleDevTools'
  | 'reload'
  | 'resetZoom'
  | 'zoomIn'
  | 'zoomOut'
  | 'togglefullscreen'
  | 'windowMenu'

export type MenuNode =
  | { kind: 'separator'; platform?: MenuPlatform }
  | { kind: 'role'; role: MenuRole; platform?: MenuPlatform }
  | {
      kind: 'command'
      commandId: string
      label: string
      accelerator?: string
      platform?: MenuPlatform
      /**
       * Where the command runs. Almost everything is dispatched into the
       * renderer's command registry so a menu item, an accelerator and the
       * command palette share one code path; `main` is for the few things no
       * renderer can do — opening a window when there may not be one.
       */
      target?: 'renderer' | 'main'
      /** Left out of the keybindings editor: one row per theme is noise. */
      bindable?: false
    }
  | { kind: 'submenu'; label: string; items: MenuNode[]; platform?: MenuPlatform }

/**
 * A top-level menu: either one with items, or one Electron builds entirely
 * itself (the macOS application menu, the Window menu). The second kind carries
 * no commands, but leaving it out of the model would mean the model was not
 * quite the menu, and the next person would have to find the rest in main.
 */
export type MenuTopLevel =
  | { kind: 'menu'; label: string; items: MenuNode[]; platform?: MenuPlatform }
  | { kind: 'role'; role: MenuRole; platform?: MenuPlatform }

export const MENU_MODEL: MenuTopLevel[] = [
  { kind: 'role', role: 'appMenu', platform: 'mac' },
  {
    kind: 'menu',
    label: 'File',
    items: [
      { kind: 'command', commandId: 'project.newFromTemplate', label: 'New Project from Template…' },
      { kind: 'command', commandId: 'project.saveAsTemplate', label: 'Save Project as Template…' },
      { kind: 'command', commandId: 'project.open', label: 'Open Folder…', accelerator: 'CmdOrCtrl+O' },
      {
        kind: 'command',
        commandId: 'window.new',
        label: 'New Window',
        accelerator: 'CmdOrCtrl+Shift+N',
        target: 'main'
      },
      { kind: 'separator' },
      { kind: 'command', commandId: 'document.new', label: 'New Document', accelerator: 'CmdOrCtrl+N' },
      // No default accelerator: CmdOrCtrl+Shift+N is already New Window.
      { kind: 'command', commandId: 'folder.new', label: 'New Folder' },
      { kind: 'command', commandId: 'document.save', label: 'Save', accelerator: 'CmdOrCtrl+S' },
      {
        kind: 'command',
        commandId: 'document.saveAll',
        label: 'Save All',
        accelerator: 'CmdOrCtrl+Alt+S'
      },
      { kind: 'separator' },
      { kind: 'command', commandId: 'document.import', label: 'Import from Word…' },
      { kind: 'command', commandId: 'document.export', label: 'Export to Word…' },
      { kind: 'command', commandId: 'document.importFountain', label: 'Import from Fountain…' },
      { kind: 'command', commandId: 'document.exportFountain', label: 'Export to Fountain…' },
      { kind: 'separator' },
      { kind: 'role', role: 'close', platform: 'mac' },
      { kind: 'role', role: 'quit', platform: 'other' }
    ]
  },
  {
    kind: 'menu',
    label: 'Edit',
    items: [
      { kind: 'role', role: 'undo' },
      { kind: 'role', role: 'redo' },
      { kind: 'separator' },
      { kind: 'role', role: 'cut' },
      { kind: 'role', role: 'copy' },
      { kind: 'role', role: 'paste' },
      { kind: 'role', role: 'selectAll' },
      { kind: 'separator' },
      { kind: 'command', commandId: 'editor.find', label: 'Find in Document', accelerator: 'CmdOrCtrl+F' },
      {
        kind: 'command',
        commandId: 'editor.replace',
        label: 'Replace in Document',
        accelerator: 'CmdOrCtrl+H'
      },
      {
        kind: 'command',
        commandId: 'search.focus',
        label: 'Search Project',
        accelerator: 'CmdOrCtrl+Shift+F'
      }
    ]
  },
  {
    kind: 'menu',
    label: 'View',
    items: [
      { kind: 'command', commandId: 'palette.quickOpen', label: 'Quick Open…', accelerator: 'CmdOrCtrl+P' },
      {
        kind: 'command',
        commandId: 'palette.commands',
        label: 'Command Palette…',
        accelerator: 'CmdOrCtrl+Shift+P'
      },
      { kind: 'separator' },
      { kind: 'command', commandId: 'panel.explorer', label: 'Explorer', accelerator: 'CmdOrCtrl+Shift+E' },
      { kind: 'command', commandId: 'panel.search', label: 'Search' },
      // No fixed entries for record panels: which kinds a project offers is
      // project data (`manifest.entityKinds`), and this menu is built once,
      // with no access to whichever project is open — see `panel.records.*`
      // in `DockRoot.tsx`. The Command Palette lists them by name instead.
      { kind: 'command', commandId: 'panel.timeline', label: 'Timeline' },
      { kind: 'command', commandId: 'panel.storyboard', label: 'Storyboard' },
      { kind: 'command', commandId: 'panel.manuscript', label: 'Manuscript' },
      { kind: 'command', commandId: 'panel.maps', label: 'Maps' },
      { kind: 'command', commandId: 'panel.ai', label: 'AI' },
      { kind: 'command', commandId: 'panel.notes', label: 'Notes' },
      { kind: 'command', commandId: 'panel.review', label: 'Review' },
      { kind: 'command', commandId: 'panel.sources', label: 'Sources' },
      { kind: 'separator' },
      { kind: 'command', commandId: 'panel.settings', label: 'Settings…', accelerator: 'CmdOrCtrl+,' },
      { kind: 'separator' },
      { kind: 'command', commandId: 'layout.savePreset', label: 'Save Layout As…' },
      { kind: 'command', commandId: 'layout.reset', label: 'Reset Layout' },
      { kind: 'command', commandId: 'layout.popout', label: 'Move Tab to New Window' },
      { kind: 'separator' },
      {
        kind: 'submenu',
        label: 'Theme',
        items: THEMES.map(({ id, label }) => ({
          kind: 'command' as const,
          commandId: `app.setTheme.${id}`,
          label,
          bindable: false as const
        }))
      },
      { kind: 'role', role: 'toggleDevTools' },
      { kind: 'role', role: 'reload' },
      { kind: 'separator' },
      { kind: 'role', role: 'resetZoom' },
      { kind: 'role', role: 'zoomIn' },
      { kind: 'role', role: 'zoomOut' },
      { kind: 'role', role: 'togglefullscreen' }
    ]
  },
  { kind: 'role', role: 'windowMenu' }
]

/**
 * The menus this platform gets, with their items filtered the same way and
 * their accelerators resolved against the person's overrides.
 *
 * One pass rather than two so main never has a half-resolved tree to reason
 * about, and so the filtering is testable without an Electron process.
 */
export function resolveMenu(
  platform: MenuPlatform,
  overrides: KeybindingOverrides = {},
  model: MenuTopLevel[] = MENU_MODEL
): MenuTopLevel[] {
  return model
    .filter((entry) => matches(entry.platform, platform))
    .map((entry) =>
      entry.kind === 'role'
        ? entry
        : { ...entry, items: resolveItems(entry.items, platform, overrides) }
    )
}

function resolveItems(
  items: MenuNode[],
  platform: MenuPlatform,
  overrides: KeybindingOverrides
): MenuNode[] {
  return items
    .filter((item) => matches(item.platform, platform))
    .map((item) => {
      if (item.kind === 'submenu') {
        return { ...item, items: resolveItems(item.items, platform, overrides) }
      }
      if (item.kind !== 'command') return item
      const accelerator = resolveAccelerator(
        {
          commandId: item.commandId,
          label: item.label,
          defaultAccelerator: item.accelerator ?? null
        },
        overrides
      )
      // Dropped rather than set to undefined: an Electron menu item with an
      // `accelerator` key present but empty renders a stray separator column.
      const { accelerator: _default, ...rest } = item
      return accelerator === null ? rest : { ...rest, accelerator }
    })
}

function matches(required: MenuPlatform | undefined, platform: MenuPlatform): boolean {
  return required === undefined || required === platform
}

/**
 * Every command a shortcut can be attached to, in menu order.
 *
 * This is what makes the keybindings editor complete by construction: a command
 * added to the menu appears there without anyone remembering to list it.
 */
export function keybindableCommands(model: MenuTopLevel[] = MENU_MODEL): CommandBinding[] {
  const found: CommandBinding[] = []
  const seen = new Set<string>()

  const walk = (items: MenuNode[]): void => {
    for (const item of items) {
      if (item.kind === 'submenu') {
        walk(item.items)
        continue
      }
      if (item.kind !== 'command' || item.bindable === false) continue
      if (seen.has(item.commandId)) continue
      seen.add(item.commandId)
      found.push({
        commandId: item.commandId,
        label: item.label,
        defaultAccelerator: item.accelerator ?? null
      })
    }
  }

  for (const entry of model) {
    if (entry.kind === 'menu') walk(entry.items)
  }
  return found
}
