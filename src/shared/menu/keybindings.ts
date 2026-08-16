import { z } from 'zod'

/**
 * Accelerators, and the rules for what counts as one.
 *
 * All pure: main needs it to build the native menu, the renderer needs it to
 * capture a combination and to warn about a clash, and neither wants a second
 * implementation of "is this the same shortcut" that disagrees at the edges —
 * `Shift+CmdOrCtrl+p` and `CmdOrCtrl+Shift+P` are one binding, and a conflict
 * check comparing raw strings would miss it.
 */
export const keybindingOverridesSchema = z.record(z.string(), z.string())
export type KeybindingOverrides = z.infer<typeof keybindingOverridesSchema>

/** Modifiers, in the order a canonical accelerator lists them. */
const MODIFIER_ORDER = ['CmdOrCtrl', 'Alt', 'Shift'] as const

const MODIFIER_ALIASES: Record<string, (typeof MODIFIER_ORDER)[number]> = {
  cmdorctrl: 'CmdOrCtrl',
  commandorcontrol: 'CmdOrCtrl',
  cmd: 'CmdOrCtrl',
  command: 'CmdOrCtrl',
  ctrl: 'CmdOrCtrl',
  control: 'CmdOrCtrl',
  super: 'CmdOrCtrl',
  meta: 'CmdOrCtrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift'
}

/**
 * Non-printing keys Electron names, mapped from the browser's `KeyboardEvent.key`.
 * Anything printable is used as-is (uppercased), which is how `CmdOrCtrl+,`
 * works without an entry here.
 *
 * Electron's own spellings are listed alongside the browser's, so that
 * canonicalising is idempotent — a captured `ArrowUp` becomes `Up`, and that
 * result then has to survive being parsed again on the way to the menu.
 */
const NAMED_KEYS: Record<string, string> = {
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  escape: 'Escape',
  esc: 'Escape',
  enter: 'Return',
  return: 'Return',
  ' ': 'Space',
  spacebar: 'Space',
  space: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown'
}

function canonicalKey(raw: string): string | null {
  const lower = raw.toLowerCase()
  const named = NAMED_KEYS[lower]
  if (named) return named
  if (/^f([1-9]|1\d|2[0-4])$/.test(lower)) return lower.toUpperCase()
  // Electron accepts a single printable character; anything longer that is not
  // named above is something this build does not know how to bind.
  if ([...raw].length === 1) return raw.toUpperCase()
  return null
}

/**
 * Parse an accelerator into its parts, or null if it is not one.
 *
 * A bare key with no modifier is rejected unless it is a function key: binding
 * a plain letter would swallow it everywhere in the app, including mid-word in
 * the editor, and there is no way back from that except editing a JSON file.
 */
export function parseAccelerator(
  accelerator: string
): { modifiers: Array<(typeof MODIFIER_ORDER)[number]>; key: string } | null {
  const parts = accelerator
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  if (parts.length === 0) return null

  const modifiers = new Set<(typeof MODIFIER_ORDER)[number]>()
  let key: string | null = null

  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()]
    if (modifier) {
      modifiers.add(modifier)
      continue
    }
    // Two non-modifier parts means something like "A+B", which is not a
    // shortcut anyone meant to type.
    if (key !== null) return null
    key = canonicalKey(part)
    if (key === null) return null
  }

  if (key === null) return null
  const isFunctionKey = /^F([1-9]|1\d|2[0-4])$/.test(key)
  if (modifiers.size === 0 && !isFunctionKey) return null

  return {
    modifiers: MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)),
    key
  }
}

/** Canonical spelling of an accelerator, or null if it is not a valid one. */
export function normalizeAccelerator(accelerator: string): string | null {
  const parsed = parseAccelerator(accelerator)
  if (!parsed) return null
  return [...parsed.modifiers, parsed.key].join('+')
}

export function isValidAccelerator(accelerator: string): boolean {
  return normalizeAccelerator(accelerator) !== null
}

/**
 * Turn a key press into an accelerator, for the capture field.
 *
 * Meta and Control both become `CmdOrCtrl` so a shortcut recorded on a Mac
 * still means the right thing on Windows — the defaults are written that way
 * too, and a binding that only worked on the machine it was set on would be a
 * poor thing to sync.
 */
export function acceleratorFromEvent(event: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}): string | null {
  const key = canonicalKey(event.key)
  if (key === null) return null
  // A modifier held on its own is a press in progress, not a shortcut.
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return null

  const modifiers: string[] = []
  if (event.ctrlKey || event.metaKey) modifiers.push('CmdOrCtrl')
  if (event.altKey) modifiers.push('Alt')
  if (event.shiftKey) modifiers.push('Shift')

  return normalizeAccelerator([...modifiers, key].join('+'))
}

export interface CommandBinding {
  commandId: string
  label: string
  /** What the menu ships with; `null` for a command with no default shortcut. */
  defaultAccelerator: string | null
}

/** The accelerator in force for a command: the override if there is one. */
export function resolveAccelerator(
  binding: CommandBinding,
  overrides: KeybindingOverrides
): string | null {
  const override = overrides[binding.commandId]
  if (override === undefined) return binding.defaultAccelerator
  // An empty override is how "unbound" is stored — distinct from "unchanged",
  // which is the key being absent altogether.
  if (override === '') return null
  return normalizeAccelerator(override)
}

/**
 * Which command, if any, already answers to an accelerator.
 *
 * Two menu items sharing a shortcut is not a warning in Electron: the second
 * one silently never fires. Reporting it before it is stored is the only point
 * at which it can be explained.
 */
export function findConflict(
  accelerator: string,
  commandId: string,
  bindings: readonly CommandBinding[],
  overrides: KeybindingOverrides
): CommandBinding | null {
  const normalized = normalizeAccelerator(accelerator)
  if (!normalized) return null
  for (const binding of bindings) {
    if (binding.commandId === commandId) continue
    if (resolveAccelerator(binding, overrides) === normalized) return binding
  }
  return null
}
