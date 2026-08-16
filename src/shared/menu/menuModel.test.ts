import { describe, it, expect } from 'vitest'
import {
  MENU_MODEL,
  resolveMenu,
  keybindableCommands,
  type MenuNode,
  type MenuTopLevel
} from './menuModel.js'
import { isValidAccelerator, normalizeAccelerator } from './keybindings.js'

function menus(model: MenuTopLevel[]): Array<{ label: string; items: MenuNode[] }> {
  return model.filter((entry) => entry.kind === 'menu')
}

function commandsIn(model: MenuTopLevel[]): Extract<MenuNode, { kind: 'command' }>[] {
  const found: Extract<MenuNode, { kind: 'command' }>[] = []
  const walk = (items: MenuNode[]): void => {
    for (const item of items) {
      if (item.kind === 'submenu') walk(item.items)
      else if (item.kind === 'command') found.push(item)
    }
  }
  for (const entry of menus(model)) walk(entry.items)
  return found
}

describe('the menu model', () => {
  it('gives every command a unique id', () => {
    const ids = commandsIn(MENU_MODEL).map((command) => command.commandId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('states every default accelerator in a form Electron accepts', () => {
    for (const command of commandsIn(MENU_MODEL)) {
      if (!command.accelerator) continue
      expect(isValidAccelerator(command.accelerator), `${command.commandId}`).toBe(true)
      // Canonical as written, so the editor shows the same text the menu does.
      expect(normalizeAccelerator(command.accelerator)).toBe(command.accelerator)
    }
  })

  /*
   * Electron gives a duplicated accelerator to whichever item it built first
   * and silently drops it from the other, so a clash shipped in the defaults
   * is a menu item that never works and never says why.
   */
  it('ships no two commands with the same default accelerator', () => {
    const byAccelerator = new Map<string, string>()
    for (const command of commandsIn(MENU_MODEL)) {
      if (!command.accelerator) continue
      const existing = byAccelerator.get(command.accelerator)
      expect(existing, `${command.accelerator} is on both ${existing} and ${command.commandId}`).toBe(
        undefined
      )
      byAccelerator.set(command.accelerator, command.commandId)
    }
  })
})

describe('resolveMenu', () => {
  it('keeps Quit off macOS and Close off everything else', () => {
    const mac = menus(resolveMenu('mac')).find((entry) => entry.label === 'File')!
    const other = menus(resolveMenu('other')).find((entry) => entry.label === 'File')!
    const roles = (items: MenuNode[]) =>
      items.filter((item) => item.kind === 'role').map((item) => item.role)

    expect(roles(mac.items)).toContain('close')
    expect(roles(mac.items)).not.toContain('quit')
    expect(roles(other.items)).toContain('quit')
    expect(roles(other.items)).not.toContain('close')
  })

  it('offers the application menu only on macOS', () => {
    const topLevelRoles = (platform: 'mac' | 'other') =>
      resolveMenu(platform)
        .filter((entry) => entry.kind === 'role')
        .map((entry) => entry.role)

    expect(topLevelRoles('mac')).toEqual(['appMenu', 'windowMenu'])
    expect(topLevelRoles('other')).toEqual(['windowMenu'])
  })

  it('applies an override in place of the default', () => {
    const save = commandsIn(resolveMenu('other', { 'document.save': 'CmdOrCtrl+Alt+W' })).find(
      (command) => command.commandId === 'document.save'
    )
    expect(save?.accelerator).toBe('CmdOrCtrl+Alt+W')
  })

  it('normalises an override that was stored loosely', () => {
    const save = commandsIn(resolveMenu('other', { 'document.save': 'shift+cmd+w' })).find(
      (command) => command.commandId === 'document.save'
    )
    expect(save?.accelerator).toBe('CmdOrCtrl+Shift+W')
  })

  /*
   * Not `accelerator: undefined`: an Electron menu item carrying the key with
   * no value renders a stray empty shortcut column beside the label.
   */
  it('drops the accelerator key entirely when a command is unbound', () => {
    const save = commandsIn(resolveMenu('other', { 'document.save': '' })).find(
      (command) => command.commandId === 'document.save'
    )
    expect(save).toBeDefined()
    expect('accelerator' in save!).toBe(false)
  })

  it('leaves the model itself untouched', () => {
    const before = JSON.stringify(MENU_MODEL)
    resolveMenu('mac', { 'document.save': 'CmdOrCtrl+Alt+W' })
    expect(JSON.stringify(MENU_MODEL)).toBe(before)
  })
})

describe('keybindableCommands', () => {
  it('lists menu commands with their defaults', () => {
    const bindings = keybindableCommands()
    expect(bindings).toContainEqual({
      commandId: 'document.save',
      label: 'Save',
      defaultAccelerator: 'CmdOrCtrl+S'
    })
    expect(bindings).toContainEqual({
      commandId: 'folder.new',
      label: 'New Folder',
      defaultAccelerator: null
    })
  })

  // One row per theme would bury the twenty commands anyone wants to rebind.
  it('leaves out the commands marked unbindable', () => {
    const ids = keybindableCommands().map((binding) => binding.commandId)
    expect(ids.some((id) => id.startsWith('app.setTheme.'))).toBe(false)
  })

  it('covers every bindable command in the model exactly once', () => {
    const expected = commandsIn(MENU_MODEL).filter((command) => command.bindable !== false)
    const bindings = keybindableCommands()
    expect(bindings).toHaveLength(new Set(expected.map((command) => command.commandId)).size)
  })
})
