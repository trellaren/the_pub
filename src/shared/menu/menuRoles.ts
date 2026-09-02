import type { MenuRole } from './menuModel.js'

/**
 * What Electron's built-in menu roles are called, and what they answer to.
 *
 * Electron labels a role item and gives it an accelerator itself, which is
 * exactly the right thing when it is drawing the menu. The in-window menu bar
 * (`renderer/chrome/`) draws its own, so on that path the labels have to exist
 * somewhere — and this is that somewhere, stated once for both the item text
 * and the shortcut shown beside it.
 *
 * Only the roles that appear *inside* a menu are here. `appMenu` and
 * `windowMenu` are whole top-level menus Electron builds itself, and they exist
 * only on macOS, where the menu bar is the system's and never drawn in-window.
 * `menuRoles.test.ts` holds this to exactly the set the model uses.
 */
export type MenuItemRole = Exclude<MenuRole, 'appMenu' | 'windowMenu'>

export const ROLE_ITEMS: Record<MenuItemRole, { label: string; accelerator?: string }> = {
  close: { label: 'Close Window', accelerator: 'CmdOrCtrl+W' },
  quit: { label: 'Quit', accelerator: 'CmdOrCtrl+Q' },
  undo: { label: 'Undo', accelerator: 'CmdOrCtrl+Z' },
  redo: { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z' },
  cut: { label: 'Cut', accelerator: 'CmdOrCtrl+X' },
  copy: { label: 'Copy', accelerator: 'CmdOrCtrl+C' },
  paste: { label: 'Paste', accelerator: 'CmdOrCtrl+V' },
  selectAll: { label: 'Select All', accelerator: 'CmdOrCtrl+A' },
  toggleDevTools: { label: 'Toggle Developer Tools' },
  reload: { label: 'Reload', accelerator: 'CmdOrCtrl+R' },
  resetZoom: { label: 'Actual Size', accelerator: 'CmdOrCtrl+0' },
  // Electron binds this role to `Plus`, which also fires on the unshifted key.
  // Shown as `=` because that is the key, and because it is a form the rest of
  // the app's accelerator handling understands.
  zoomIn: { label: 'Zoom In', accelerator: 'CmdOrCtrl+=' },
  zoomOut: { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-' },
  togglefullscreen: { label: 'Toggle Full Screen' }
}
