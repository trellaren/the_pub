import { Menu, BrowserWindow } from 'electron'
import type { WindowManager } from './windows/windowManager.js'

/**
 * Native menu. Every item dispatches a command id into the renderer's command
 * registry rather than acting directly, so a menu item, a keyboard shortcut and
 * the command palette all run exactly the same code path.
 */
export function buildMenu(windows: WindowManager, createWindow: () => BrowserWindow): void {
  const send = (commandId: string) => (): void => {
    const focused = BrowserWindow.getFocusedWindow()
    if (focused) windows.send(focused.webContents, 'command:invoke', { commandId })
  }

  const isMac = process.platform === 'darwin'

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? ([{ role: 'appMenu' }] as Electron.MenuItemConstructorOptions[]) : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: send('project.open') },
        { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => createWindow() },
        { type: 'separator' },
        { label: 'New Document', accelerator: 'CmdOrCtrl+N', click: send('document.new') },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: send('document.save') },
        { label: 'Save All', accelerator: 'CmdOrCtrl+Alt+S', click: send('document.saveAll') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find in Document', accelerator: 'CmdOrCtrl+F', click: send('editor.find') },
        { label: 'Replace in Document', accelerator: 'CmdOrCtrl+H', click: send('editor.replace') },
        { label: 'Search Project', accelerator: 'CmdOrCtrl+Shift+F', click: send('search.focus') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Quick Open…', accelerator: 'CmdOrCtrl+P', click: send('palette.quickOpen') },
        { label: 'Command Palette…', accelerator: 'CmdOrCtrl+Shift+P', click: send('palette.commands') },
        { type: 'separator' },
        { label: 'Explorer', accelerator: 'CmdOrCtrl+Shift+E', click: send('panel.explorer') },
        { label: 'Search', click: send('panel.search') },
        { type: 'separator' },
        { label: 'Save Layout As…', click: send('layout.savePreset') },
        { label: 'Reset Layout', click: send('layout.reset') },
        { label: 'Move Tab to New Window', click: send('layout.popout') },
        { type: 'separator' },
        { label: 'Toggle Theme', click: send('app.toggleTheme') },
        { role: 'toggleDevTools' },
        { role: 'reload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
