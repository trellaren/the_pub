import { describe, expect, it } from 'vitest'
import { MENU_MODEL, resolveMenu, type MenuNode, type MenuRole } from './menuModel.js'
import { isValidAccelerator, normalizeAccelerator } from './keybindings.js'
import { ROLE_ITEMS } from './menuRoles.js'

function itemRolesIn(platform: 'mac' | 'other'): MenuRole[] {
  const found: MenuRole[] = []
  const walk = (items: MenuNode[]): void => {
    for (const item of items) {
      if (item.kind === 'submenu') walk(item.items)
      else if (item.kind === 'role') found.push(item.role)
    }
  }
  for (const entry of resolveMenu(platform, {}, MENU_MODEL)) {
    if (entry.kind === 'menu') walk(entry.items)
  }
  return found
}

describe('the built-in menu roles', () => {
  /*
   * The in-window menu bar renders a role item from this table alone. A role
   * used in the model with no entry here is a menu item with no name, and one
   * listed here that the model never uses is a label nobody will ever see go
   * wrong — so the set is pinned in both directions.
   */
  it('names exactly the roles the menu uses inside a menu', () => {
    const used = new Set([...itemRolesIn('mac'), ...itemRolesIn('other')])
    expect([...used].sort()).toEqual(Object.keys(ROLE_ITEMS).sort())
  })

  it('states shortcuts in the same form the rest of the menu does', () => {
    for (const [role, item] of Object.entries(ROLE_ITEMS)) {
      if (!item.accelerator) continue
      expect(isValidAccelerator(item.accelerator), role).toBe(true)
      expect(normalizeAccelerator(item.accelerator)).toBe(item.accelerator)
    }
  })

  it('gives every role a label', () => {
    for (const [role, item] of Object.entries(ROLE_ITEMS)) {
      expect(item.label.length, role).toBeGreaterThan(0)
    }
  })
})
