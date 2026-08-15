import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { invoke, attempt } from '@renderer/lib/ipc.js'
import { TextInput, cx } from '@renderer/ui/primitives.js'

interface Candidate {
  path: string
  title: string
  docId: string
  inBook: boolean
}

/**
 * Choose documents to bring into the book.
 *
 * A document already in the book is filtered out rather than shown disabled —
 * the rule it enforces is "once", and a picker cluttered with everything
 * already placed would make finding what is not in the book harder for no
 * benefit. `mode: 'relink'` narrows to a single choice, for pointing one row
 * at a replacement file.
 */
export function DocumentPicker({
  mode,
  onCancel,
  onConfirm,
  ownerDocument
}: {
  mode: 'add' | 'relink'
  onCancel: () => void
  onConfirm: (paths: string[]) => void
  ownerDocument?: Document
}) {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null)
  const [query, setQuery] = useState('')
  const [checked, setChecked] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const list = await attempt(invoke('manuscript:candidates', {}), 'Could not list documents')
      if (!cancelled && list) setCandidates(list.filter((item) => !item.inBook))
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const filtered = (candidates ?? []).filter((item) =>
    item.title.toLowerCase().includes(query.toLowerCase())
  )

  const toggle = (path: string): void => {
    if (mode === 'relink') {
      setChecked(new Set([path]))
      return
    }
    const next = new Set(checked)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setChecked(next)
  }

  const dialog = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div
        data-testid="document-picker"
        className="flex h-[26rem] w-[26rem] flex-col gap-2 rounded border border-border bg-surface p-3"
      >
        <h2 className="text-[13px] text-text">
          {mode === 'add' ? 'Add documents to the book' : 'Relink to a document'}
        </h2>
        <TextInput
          autoFocus
          placeholder="Filter…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="flex-1 overflow-auto rounded border border-border">
          {candidates === null ? (
            <p className="p-3 text-[12px] text-faint">Loading…</p>
          ) : filtered.length === 0 ? (
            <p className="p-3 text-[12px] text-faint">
              {candidates.length === 0 ? 'Every document is already in the book.' : 'No matches.'}
            </p>
          ) : (
            filtered.map((item) => (
              <label
                key={item.docId}
                data-testid="document-picker-item"
                className="flex cursor-default items-center gap-2 px-2 py-1 text-[12px] text-text hover:bg-surface-2"
              >
                <input
                  type={mode === 'add' ? 'checkbox' : 'radio'}
                  name="document-picker"
                  checked={checked.has(item.path)}
                  onChange={() => toggle(item.path)}
                />
                <span className="flex-1 truncate">{item.title}</span>
                <span className="truncate text-[10px] text-faint">{item.path}</span>
              </label>
            ))
          )}
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="pub-focus-ring h-7 rounded border border-border px-3 text-[12px] text-muted hover:bg-surface-3 hover:text-text"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="document-picker-confirm"
            disabled={checked.size === 0}
            className={cx(
              'pub-focus-ring h-7 rounded px-3 text-[12px]',
              'bg-accent-soft text-accent hover:brightness-110 disabled:opacity-40'
            )}
            onClick={() => onConfirm([...checked])}
          >
            {mode === 'add' ? 'Add' : 'Relink'}
          </button>
        </div>
      </div>
    </div>
  )

  return createPortal(dialog, ownerDocument?.body ?? document.body)
}
