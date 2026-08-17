import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { TextInput, cx } from './primitives.js'
import { useModalFocusTrap } from './useModalFocusTrap.js'

/*
 * The replacement for the browser's native prompt(), which Electron does not
 * implement — it throws, and eight create flows shipped dead because of it.
 * (noNativeDialogs.test.ts keeps it from coming back.)
 *
 * Imperative and promise-returning rather than a declarative component, because
 * every call site was `const name = prompt(…)` inside an async function:
 * `await promptForName(…)` preserves that control flow as a one-line change,
 * where a component would make five panels each grow modal state and a split
 * continuation. `reportError`/`reportNotice` already established this shape —
 * module-level functions, one host rendering them.
 */

export interface PromptRequest {
  title: string
  label?: string
  defaultValue?: string
  /** Defaults to 'Create'. */
  confirmLabel?: string
  placeholder?: string
  /** A message to show under the field, or null when the value is usable. */
  validate?: (value: string) => string | null
  /**
   * The document to show the dialog in.
   *
   * Popout windows share this window's JS context — popout.html has no script
   * of its own; dockview portals the opener's React tree into it. So there is
   * exactly one PromptHost, and without a target it would always render into
   * the opener's document: a dialog triggered from a torn-off pane would open
   * behind it, in the other window. Call sites are click handlers, so they
   * pass `event.currentTarget.ownerDocument`.
   */
  ownerDocument?: Document
}

interface PendingPrompt {
  request: PromptRequest
  resolve: (value: string | null) => void
}

let pending: PendingPrompt | null = null
const listeners = new Set<() => void>()

function setPending(next: PendingPrompt | null): void {
  pending = next
  for (const listener of listeners) listener()
}

/**
 * Ask for one line of text. Resolves the trimmed value, or null on cancel.
 *
 * A second prompt while one is open cancels the first — a single slot is all
 * eight call sites need, and a queue would mean dialogs appearing later with
 * no visible cause.
 */
export function promptForName(request: PromptRequest): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    pending?.resolve(null)
    setPending({ request, resolve })
  })
}

/** Mounted once in App; renders the open prompt, portalled to its target window. */
export function PromptHost() {
  const current = useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    },
    () => pending
  )
  if (!current) return null
  return <PromptView key={currentKey(current)} pending={current} />
}

/** Remount per request so field state never leaks from one prompt into the next. */
let promptSerial = 0
const keys = new WeakMap<PendingPrompt, number>()
function currentKey(current: PendingPrompt): number {
  let key = keys.get(current)
  if (key === undefined) {
    key = ++promptSerial
    keys.set(current, key)
  }
  return key
}

function PromptView({ pending: current }: { pending: PendingPrompt }) {
  const { request } = current
  const [value, setValue] = useState(request.defaultValue ?? '')
  const inputRef = useRef<HTMLInputElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  useModalFocusTrap(formRef)

  const problem = request.validate ? request.validate(value.trim()) : null
  const usable = value.trim().length > 0 && !problem

  const finish = (result: string | null): void => {
    current.resolve(result)
    setPending(null)
  }

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const dialog = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) finish(null)
      }}
    >
      <form
        ref={formRef}
        role="dialog"
        aria-modal="true"
        aria-label={request.title}
        data-testid="prompt-dialog"
        className="flex w-[22rem] flex-col gap-2 rounded border border-border bg-surface p-3"
        onSubmit={(event) => {
          event.preventDefault()
          if (usable) finish(value.trim())
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') finish(null)
        }}
      >
        <h2 className="text-[13px] text-text">{request.title}</h2>
        <label className="flex flex-col gap-1 text-[12px] text-muted">
          {request.label ? <span>{request.label}</span> : null}
          <TextInput
            ref={inputRef}
            data-testid="prompt-input"
            value={value}
            placeholder={request.placeholder}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        {problem ? (
          <p data-testid="prompt-error" className="text-[12px] text-danger">
            {problem}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            data-testid="prompt-cancel"
            className="pub-focus-ring h-7 rounded border border-border px-3 text-[12px] text-muted hover:bg-surface-3 hover:text-text"
            onClick={() => finish(null)}
          >
            Cancel
          </button>
          <button
            type="submit"
            data-testid="prompt-confirm"
            disabled={!usable}
            className={cx(
              'pub-focus-ring h-7 rounded px-3 text-[12px]',
              'bg-accent-soft text-accent hover:brightness-110 disabled:opacity-40'
            )}
          >
            {request.confirmLabel ?? 'Create'}
          </button>
        </div>
      </form>
    </div>
  )

  const target = request.ownerDocument?.body ?? document.body
  return createPortal(dialog, target)
}
