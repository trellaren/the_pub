export interface Command {
  id: string
  title: string
  run: () => void
  /**
   * Several panels can register the same command — every open editor registers
   * "Find in Document". This decides which registration a dispatch reaches,
   * normally by asking whether the panel is the active one.
   */
  isEnabled?: () => boolean
}

const commands = new Map<string, Command[]>()
const listeners = new Set<() => void>()

/** Register a command; returns the unregister function for effect cleanup. */
export function registerCommand(command: Command): () => void {
  const existing = commands.get(command.id) ?? []
  commands.set(command.id, [...existing, command])
  notify()
  return () => {
    const remaining = (commands.get(command.id) ?? []).filter((entry) => entry !== command)
    if (remaining.length === 0) commands.delete(command.id)
    else commands.set(command.id, remaining)
    notify()
  }
}

export function runCommand(id: string): boolean {
  const candidates = commands.get(id)
  if (!candidates || candidates.length === 0) return false
  const target = candidates.find((command) => command.isEnabled?.() ?? true) ?? candidates.at(-1)
  if (!target) return false
  target.run()
  return true
}

/** Every command that can run right now, for the command palette. */
export function listCommands(): Command[] {
  const unique = new Map<string, Command>()
  for (const [id, candidates] of commands) {
    const target = candidates.find((command) => command.isEnabled?.() ?? true) ?? candidates.at(-1)
    if (target) unique.set(id, target)
  }
  return [...unique.values()].sort((a, b) => a.title.localeCompare(b.title))
}

export function onCommandsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify(): void {
  for (const listener of listeners) listener()
}
