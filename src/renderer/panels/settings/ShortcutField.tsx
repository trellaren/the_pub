import { useState } from 'react'
import { cx } from '@renderer/ui/primitives.js'
import { acceleratorFromEvent, type CommandBinding } from '@shared/menu/keybindings.js'
import type { KeybindingResult } from '@renderer/stores/appStore.js'

/**
 * One rebindable command.
 *
 * The combination is captured from a real key press rather than typed: nobody
 * should have to know that Electron spells it `CmdOrCtrl+Shift+P`, and a typed
 * accelerator is the kind of thing that is wrong in a way no validation
 * message makes obvious.
 */
export function ShortcutField({
  binding,
  accelerator,
  isOverridden,
  onBind
}: {
  binding: CommandBinding
  /** In force now — the override if there is one, else the default. */
  accelerator: string | null
  isOverridden: boolean
  onBind: (accelerator: string | null) => Promise<KeybindingResult>
}) {
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (next: string | null): Promise<void> => {
    setRecording(false)
    const result = await onBind(next)
    if (result === null) {
      setError(null)
      return
    }
    setError(
      result.reason === 'conflict'
        ? `Already used by ${result.conflictWith}`
        : result.reason === 'invalid'
          ? 'Needs a modifier — Ctrl, Alt or Shift'
          : 'That command cannot be bound'
    )
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    // Everything, including Tab and Escape, so a capture cannot leak a keystroke
    // into the app behind it.
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') {
      setRecording(false)
      return
    }
    const captured = acceleratorFromEvent(event)
    if (captured) void submit(captured)
  }

  return (
    <div className="mb-2 flex items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-[12px] text-muted" title={binding.label}>
        {binding.label}
      </span>
      <button
        type="button"
        aria-label={`Shortcut for ${binding.label}`}
        className={cx(
          'pub-focus-ring h-7 min-w-[7.5rem] rounded border px-2 text-[12px]',
          recording
            ? 'border-accent bg-surface-2 text-accent'
            : 'border-border bg-surface-2 text-text hover:border-faint',
          isOverridden && !recording && 'font-medium'
        )}
        onClick={() => {
          setError(null)
          setRecording((active) => !active)
        }}
        onBlur={() => setRecording(false)}
        onKeyDown={recording ? onKeyDown : undefined}
      >
        {recording ? 'Press a combination…' : (accelerator ?? 'Unassigned')}
      </button>
      <button
        type="button"
        aria-label={`Reset shortcut for ${binding.label}`}
        className={cx(
          'pub-focus-ring h-7 rounded border border-border px-2 text-[12px] text-muted',
          'hover:border-faint hover:text-text disabled:opacity-40'
        )}
        disabled={!isOverridden}
        onClick={() => void submit(null)}
      >
        Reset
      </button>
      {error ? <span className="text-[11px] text-danger">{error}</span> : null}
    </div>
  )
}
