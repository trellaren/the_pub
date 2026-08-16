import { Menu, BrowserWindow } from 'electron'
import type { WindowManager } from './windows/windowManager.js'
import { resolveMenu, type MenuNode, type MenuTopLevel } from '../shared/menu/menuModel.js'
import type { KeybindingOverrides } from '../shared/menu/keybindings.js'

/**
 * Native menu, built from the shared menu model.
 *
 * Every item dispatches a command id into the renderer's command registry
 * rather than acting directly, so a menu item, a keyboard shortcut and the
 * command palette all run exactly the same code path. The handful that main has
 * to run itself are marked `target: 'main'` in the model and looked up here.
 *
 * The tree itself lives in `shared/menu/menuModel.ts`; this file is only the
 * translation into Electron's template shape, which is what keeps the tree
 * testable and lets Settings list what is bindable.
 */
export function buildMenu(
  windows: WindowManager,
  createWindow: () => BrowserWindow,
  overrides: KeybindingOverrides = {}
): void {
  const send = (commandId: string) => (): void => {
    const focused = BrowserWindow.getFocusedWindow()
    if (focused) windows.send(focused.webContents, 'command:invoke', { commandId })
  }

  const mainCommands: Record<string, () => void> = {
    'window.new': () => void createWindow()
  }

  const platform = process.platform === 'darwin' ? 'mac' : 'other'
  const template = resolveMenu(platform, overrides).map(toTopLevel)

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))

  function toTopLevel(entry: MenuTopLevel): Electron.MenuItemConstructorOptions {
    return entry.kind === 'role'
      ? { role: entry.role as Electron.MenuItemConstructorOptions['role'] }
      : { label: entry.label, submenu: entry.items.map(toItem) }
  }

  function toItem(node: MenuNode): Electron.MenuItemConstructorOptions {
    switch (node.kind) {
      case 'separator':
        return { type: 'separator' }
      case 'role':
        return { role: node.role as Electron.MenuItemConstructorOptions['role'] }
      case 'submenu':
        return { label: node.label, submenu: node.items.map(toItem) }
      case 'command': {
        const click =
          node.target === 'main'
            ? // A model entry naming a main-side command nobody implements is a
              // wiring bug; a no-op item would hide it until someone clicked.
              (mainCommands[node.commandId] ??
              (() => {
                throw new Error(`No main-process handler for the command "${node.commandId}"`)
              }))
            : send(node.commandId)
        return node.accelerator
          ? { label: node.label, accelerator: node.accelerator, click }
          : { label: node.label, click }
      }
    }
  }
}
