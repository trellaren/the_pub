import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { TextInput, cx } from '@renderer/ui/primitives.js'
import { useModalFocusTrap } from '@renderer/ui/useModalFocusTrap.js'
import { validateRelativePath } from '@shared/model/filename.js'
import type { EditRole, PickedFile, ShellRequest } from '../protocol.js'
import { authSession, cancelAuthSession, nativeHttp, openExternal, saveFile } from './native.js'

/**
 * The page's half of everything the host cannot do from a worker: the dialogs
 * Electron's main process draws natively, the file picker, the print sheet.
 */

type DialogRequest =
  | Extract<ShellRequest, { op: 'messageBox' | 'pickFolder' }>
  | { op: 'confirmPick'; title: string }

interface OpenDialog {
  request: DialogRequest
  resolve: (value: unknown) => void
}

let open: OpenDialog | null = null
const subscribers = new Set<() => void>()

function show(request: DialogRequest): Promise<unknown> {
  return new Promise((resolve) => {
    open = { request, resolve }
    for (const notify of subscribers) notify()
  })
}

function close(value: unknown): void {
  const closing = open
  open = null
  for (const notify of subscribers) notify()
  closing?.resolve(value)
}

const BUTTON = 'pub-focus-ring h-9 rounded px-4 text-[13px]'
const QUIET = cx(BUTTON, 'border border-border text-muted hover:bg-surface-3 hover:text-text')
const PRIMARY = cx(BUTTON, 'bg-accent-soft text-accent hover:brightness-110 disabled:opacity-40')

function Frame({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useModalFocusTrap(ref)
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-6">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        data-testid="shell-dialog"
        className="flex w-full max-w-sm flex-col gap-3 rounded border border-border bg-surface p-4"
      >
        {children}
      </div>
    </div>
  )
}

function MessageBox({ request }: { request: Extract<ShellRequest, { op: 'messageBox' }> }): React.JSX.Element {
  return (
    <Frame label={request.message}>
      <h2 className="text-[14px] text-text">{request.message}</h2>
      {request.detail ? <p className="text-[13px] text-muted">{request.detail}</p> : null}
      <div className="flex justify-end gap-2">
        {request.buttons.map((label, index) => (
          <button
            key={label}
            type="button"
            data-testid={`shell-button-${index}`}
            className={index === request.cancelId ? QUIET : PRIMARY}
            onClick={() => close({ response: index })}
          >
            {label}
          </button>
        ))}
      </div>
    </Frame>
  )
}

function FolderPicker({ request }: { request: Extract<ShellRequest, { op: 'pickFolder' }> }): React.JSX.Element {
  const creating = request.purpose === 'create'
  const [name, setName] = useState('')
  const trimmed = name.trim()
  const invalid = trimmed ? validateRelativePath(trimmed) : null
  const problem =
    trimmed.includes('/') || trimmed.includes('\\')
      ? 'A project name cannot contain a slash.'
      : invalid && !invalid.ok
        ? invalid.reason
        : creating && request.existing.includes(trimmed)
          ? 'A project with that name is already on this device.'
          : null

  return (
    <Frame label={request.title}>
      <h2 className="text-[14px] text-text">{request.title}</h2>
      {creating ? null : (
        <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto" data-testid="shell-folder-list">
          {request.existing.length === 0 ? (
            <li className="text-[13px] text-muted">No projects are stored on this device yet.</li>
          ) : null}
          {request.existing.map((folder) => (
            <li key={folder}>
              <button type="button" className={cx(QUIET, 'w-full text-left')} onClick={() => close({ name: folder })}>
                {folder}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (trimmed && !problem) close({ name: trimmed })
        }}
      >
        <label className="flex flex-col gap-1 text-[12px] text-muted">
          <span>{creating ? 'Name the project. It is kept on this device.' : 'Or start a new one on this device'}</span>
          <TextInput
            data-testid="shell-folder-name"
            value={name}
            placeholder="Project name"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {problem ? <p className="text-[12px] text-danger">{problem}</p> : null}
        <div className="flex justify-end gap-2">
          <button type="button" data-testid="shell-cancel" className={QUIET} onClick={() => close(null)}>
            Cancel
          </button>
          <button type="submit" data-testid="shell-confirm" className={PRIMARY} disabled={!trimmed || Boolean(problem)}>
            {creating ? 'Create' : 'Open'}
          </button>
        </div>
      </form>
    </Frame>
  )
}

function ConfirmPick({ title }: { title: string }): React.JSX.Element {
  return (
    <Frame label={title}>
      <h2 className="text-[14px] text-text">{title}</h2>
      <div className="flex justify-end gap-2">
        <button type="button" className={QUIET} onClick={() => close(false)}>
          Cancel
        </button>
        <button type="button" data-testid="shell-confirm" className={PRIMARY} onClick={() => close(true)}>
          Choose…
        </button>
      </div>
    </Frame>
  )
}

function ShellHost(): React.JSX.Element | null {
  const current = useSyncExternalStore(
    (notify) => {
      subscribers.add(notify)
      return () => subscribers.delete(notify)
    },
    () => open
  )
  useEffect(() => {
    if (!current) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      const { request } = current
      close(request.op === 'messageBox' ? { response: request.cancelId } : request.op === 'confirmPick' ? false : null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current])

  if (!current) return null
  const { request } = current
  if (request.op === 'messageBox') return <MessageBox request={request} />
  if (request.op === 'pickFolder') return <FolderPicker request={request} />
  return <ConfirmPick title={request.title} />
}

/**
 * The system file picker only opens from inside a tap. The request for one
 * arrives by way of the worker, and by then the tap that started it may no
 * longer count — in which case a button is shown, and its tap does.
 */
async function pickFiles(request: Extract<ShellRequest, { op: 'pickFiles' }>): Promise<PickedFile[] | null> {
  if (navigator.userActivation && !navigator.userActivation.isActive) {
    if (!(await show({ op: 'confirmPick', title: request.title }))) return null
  }
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = request.multiple
  input.accept = request.extensions.map((extension) => `.${extension}`).join(',')
  input.style.display = 'none'
  input.dataset.testid = 'shell-file-input'
  document.body.append(input)
  try {
    const files = await new Promise<File[]>((resolve) => {
      input.addEventListener('change', () => resolve([...(input.files ?? [])]))
      input.addEventListener('cancel', () => resolve([]))
      input.click()
    })
    if (files.length === 0) return null
    return await Promise.all(
      files.map(async (file) => ({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }))
    )
  } finally {
    input.remove()
  }
}

async function edit(role: EditRole): Promise<null> {
  if (role === 'paste') {
    // `execCommand('paste')` is refused to pages; the clipboard API asks the person instead.
    const text = await navigator.clipboard.readText().catch(() => '')
    if (text) document.execCommand('insertText', false, text)
  } else {
    document.execCommand(role)
  }
  return null
}

function print(html: string): Promise<null> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe')
    frame.setAttribute('aria-hidden', 'true')
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden'
    frame.srcdoc = html
    frame.onload = () => {
      const target = frame.contentWindow
      if (!target) {
        frame.remove()
        reject(new Error('Printing is not available here.'))
        return
      }
      void (target.document.fonts?.ready ?? Promise.resolve()).then(() => {
        target.addEventListener('afterprint', () => frame.remove())
        target.focus()
        target.print()
        resolve(null)
      })
    }
    document.body.append(frame)
  })
}

export function runShell(request: ShellRequest): Promise<unknown> {
  switch (request.op) {
    case 'messageBox':
    case 'pickFolder':
      return show(request)
    case 'pickFiles':
      return pickFiles(request)
    case 'saveFile':
      return saveFile(request.name, request.bytes).then(() => null)
    case 'openExternal':
      return openExternal(request.url).then(() => null)
    case 'authSession':
      return authSession(request.url, request.redirectUri)
    case 'authCancel':
      cancelAuthSession()
      return Promise.resolve(null)
    case 'edit':
      return edit(request.role)
    case 'zoom':
      document.documentElement.style.setProperty('zoom', String(1.2 ** request.level))
      return Promise.resolve(null)
    case 'setTitle':
      document.title = request.title
      return Promise.resolve(null)
    case 'print':
      return print(request.html)
    case 'http':
      return nativeHttp(request.request)
  }
}

export function mountShell(container: HTMLElement): void {
  createRoot(container).render(<ShellHost />)
}
