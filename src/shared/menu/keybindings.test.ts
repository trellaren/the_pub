import { describe, it, expect } from 'vitest'
import {
  normalizeAccelerator,
  isValidAccelerator,
  parseAccelerator,
  acceleratorFromEvent,
  resolveAccelerator,
  acceleratorLabel,
  findConflict,
  type CommandBinding
} from './keybindings.js'

describe('normalizeAccelerator', () => {
  it('puts modifiers in a canonical order, so equal shortcuts compare equal', () => {
    expect(normalizeAccelerator('Shift+CmdOrCtrl+p')).toBe('CmdOrCtrl+Shift+P')
    expect(normalizeAccelerator('CmdOrCtrl+Shift+P')).toBe('CmdOrCtrl+Shift+P')
    expect(normalizeAccelerator('Shift+Alt+CmdOrCtrl+k')).toBe('CmdOrCtrl+Alt+Shift+K')
  })

  it('treats every name for the command key as the same modifier', () => {
    for (const spelling of ['Cmd+S', 'Command+S', 'Ctrl+S', 'Control+S', 'CmdOrCtrl+S', 'Meta+S']) {
      expect(normalizeAccelerator(spelling)).toBe('CmdOrCtrl+S')
    }
    expect(normalizeAccelerator('Option+S')).toBe('Alt+S')
  })

  it('keeps punctuation and function keys', () => {
    expect(normalizeAccelerator('CmdOrCtrl+,')).toBe('CmdOrCtrl+,')
    expect(normalizeAccelerator('f5')).toBe('F5')
    expect(normalizeAccelerator('F12')).toBe('F12')
  })

  it('accepts a bare function key but not a bare character', () => {
    expect(isValidAccelerator('F5')).toBe(true)
    // A bare letter would swallow that key everywhere, including mid-word in
    // the editor, with no way back except editing JSON by hand.
    expect(isValidAccelerator('S')).toBe(false)
    expect(isValidAccelerator(',')).toBe(false)
  })

  it('rejects nonsense', () => {
    expect(normalizeAccelerator('')).toBeNull()
    expect(normalizeAccelerator('+')).toBeNull()
    expect(normalizeAccelerator('CmdOrCtrl')).toBeNull()
    expect(normalizeAccelerator('CmdOrCtrl+Nonsense')).toBeNull()
    expect(normalizeAccelerator('CmdOrCtrl+A+B')).toBeNull()
    expect(normalizeAccelerator('CmdOrCtrl+F25')).toBeNull()
  })

  /*
   * A captured `ArrowUp` becomes `Up`, and that result is parsed again on its
   * way into the menu — a canonical form that did not survive its own parser
   * silently dropped every arrow-key binding.
   */
  it('is idempotent, including for named keys', () => {
    for (const accelerator of [
      'CmdOrCtrl+Shift+P',
      'Alt+Up',
      'CmdOrCtrl+Return',
      'CmdOrCtrl+Space',
      'CmdOrCtrl+PageDown',
      'CmdOrCtrl+,',
      'F5'
    ]) {
      expect(normalizeAccelerator(accelerator), accelerator).toBe(accelerator)
    }
  })

  it('reports the parsed parts', () => {
    expect(parseAccelerator('Shift+CmdOrCtrl+F')).toEqual({
      modifiers: ['CmdOrCtrl', 'Shift'],
      key: 'F'
    })
  })
})

describe('acceleratorFromEvent', () => {
  const event = (over: Partial<Parameters<typeof acceleratorFromEvent>[0]>) => ({
    key: 'a',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...over
  })

  it('maps either command key to the portable modifier', () => {
    expect(acceleratorFromEvent(event({ key: 's', metaKey: true }))).toBe('CmdOrCtrl+S')
    expect(acceleratorFromEvent(event({ key: 's', ctrlKey: true }))).toBe('CmdOrCtrl+S')
  })

  it('captures combinations and named keys', () => {
    expect(acceleratorFromEvent(event({ key: 'p', ctrlKey: true, shiftKey: true }))).toBe(
      'CmdOrCtrl+Shift+P'
    )
    expect(acceleratorFromEvent(event({ key: 'ArrowUp', altKey: true }))).toBe('Alt+Up')
    expect(acceleratorFromEvent(event({ key: 'Enter', ctrlKey: true }))).toBe('CmdOrCtrl+Return')
    expect(acceleratorFromEvent(event({ key: ' ', ctrlKey: true }))).toBe('CmdOrCtrl+Space')
  })

  it('ignores a modifier held on its own — that is a press in progress', () => {
    expect(acceleratorFromEvent(event({ key: 'Shift', shiftKey: true }))).toBeNull()
    expect(acceleratorFromEvent(event({ key: 'Control', ctrlKey: true }))).toBeNull()
    expect(acceleratorFromEvent(event({ key: 'Meta', metaKey: true }))).toBeNull()
  })

  it('ignores an unmodified character', () => {
    expect(acceleratorFromEvent(event({ key: 'a' }))).toBeNull()
  })

  it('accepts an unmodified function key', () => {
    expect(acceleratorFromEvent(event({ key: 'F5' }))).toBe('F5')
  })
})

describe('resolveAccelerator', () => {
  const save: CommandBinding = {
    commandId: 'document.save',
    label: 'Save',
    defaultAccelerator: 'CmdOrCtrl+S'
  }
  const unbound: CommandBinding = {
    commandId: 'folder.new',
    label: 'New Folder',
    defaultAccelerator: null
  }

  it('uses the default when nothing was changed', () => {
    expect(resolveAccelerator(save, {})).toBe('CmdOrCtrl+S')
    expect(resolveAccelerator(unbound, {})).toBeNull()
  })

  it('uses the override when there is one, normalised', () => {
    expect(resolveAccelerator(save, { 'document.save': 'shift+ctrl+w' })).toBe('CmdOrCtrl+Shift+W')
  })

  // Absent means "unchanged", empty means "deliberately unbound" — a default
  // that came back after someone cleared it would be a bug they could not fix.
  it('distinguishes an unbound command from an unchanged one', () => {
    expect(resolveAccelerator(save, { 'document.save': '' })).toBeNull()
    expect(resolveAccelerator(save, {})).toBe('CmdOrCtrl+S')
  })
})

describe('findConflict', () => {
  const bindings: CommandBinding[] = [
    { commandId: 'document.save', label: 'Save', defaultAccelerator: 'CmdOrCtrl+S' },
    { commandId: 'project.open', label: 'Open Folder…', defaultAccelerator: 'CmdOrCtrl+O' },
    { commandId: 'folder.new', label: 'New Folder', defaultAccelerator: null }
  ]

  it('finds the command already holding a combination', () => {
    expect(findConflict('CmdOrCtrl+S', 'folder.new', bindings, {})?.label).toBe('Save')
  })

  it('compares canonically rather than by string', () => {
    expect(findConflict('ctrl+s', 'folder.new', bindings, {})?.label).toBe('Save')
  })

  it('does not report a command conflicting with itself', () => {
    expect(findConflict('CmdOrCtrl+S', 'document.save', bindings, {})).toBeNull()
  })

  it('sees through overrides in both directions', () => {
    // Save has moved away, so its default is free.
    expect(findConflict('CmdOrCtrl+S', 'folder.new', bindings, { 'document.save': 'CmdOrCtrl+W' })).toBeNull()
    // ...and taken something else's place.
    expect(
      findConflict('CmdOrCtrl+W', 'folder.new', bindings, { 'document.save': 'CmdOrCtrl+W' })?.label
    ).toBe('Save')
  })

  it('reports nothing for a free combination or an invalid one', () => {
    expect(findConflict('CmdOrCtrl+J', 'folder.new', bindings, {})).toBeNull()
    expect(findConflict('nonsense', 'folder.new', bindings, {})).toBeNull()
  })
})

describe('acceleratorLabel', () => {
  it('names the key a Windows or Linux reader would press', () => {
    expect(acceleratorLabel('CmdOrCtrl+Shift+P', 'linux')).toBe('Ctrl+Shift+P')
    expect(acceleratorLabel('CmdOrCtrl+Alt+S', 'win32')).toBe('Ctrl+Alt+S')
  })

  it('uses the Mac symbols, run together, on a Mac', () => {
    expect(acceleratorLabel('CmdOrCtrl+Shift+P', 'darwin')).toBe('⌘⇧P')
    expect(acceleratorLabel('CmdOrCtrl+Alt+S', 'darwin')).toBe('⌘⌥S')
  })

  it('leaves a key it has no symbol for alone', () => {
    expect(acceleratorLabel('CmdOrCtrl+,', 'linux')).toBe('Ctrl+,')
    expect(acceleratorLabel('F5', 'darwin')).toBe('F5')
  })
})
