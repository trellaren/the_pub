import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { fitToMapBox } from '@shared/model/map.js'
import { TextInput, cx } from '@renderer/ui/primitives.js'
import { invoke, attempt, errorMessage, reportError } from '@renderer/lib/ipc.js'
import { bytesToBase64 } from '@renderer/lib/assets.js'
import { useMapStore } from '@renderer/stores/mapStore.js'
import { useModalFocusTrap } from '@renderer/ui/useModalFocusTrap.js'

interface PickedImage {
  name: string
  /** Data URL for the preview thumbnail; the raw bytes go over IPC separately. */
  preview: string
  base64: string
  ext: string
  width: number
  height: number
}

/**
 * Name a map, and choose how it starts: an imported image to draw over, or a
 * blank sheet. One dialog rather than a choice-then-name sequence — the image
 * is simply optional, and leaving it empty is what "sketch" means.
 *
 * The file arrives through a hidden HTML input, not a native dialog, for the
 * reason the docx feature split its channels: Playwright cannot operate a
 * native dialog, and an untestable create flow is how this panel shipped with
 * a dead button in the first place.
 */
export function NewMapDialog({
  ownerDocument,
  onClose
}: {
  ownerDocument?: Document
  onClose: () => void
}) {
  const [name, setName] = useState('The world')
  const [picked, setPicked] = useState<PickedImage | null>(null)
  const [busy, setBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const formRef = useRef<HTMLFormElement>(null)

  const pick = async (file: File): Promise<void> => {
    try {
      const buffer = await file.arrayBuffer()
      const bitmap = await createImageBitmap(file)
      const { width, height } = bitmap
      bitmap.close()
      setPicked({
        name: file.name,
        preview: URL.createObjectURL(file),
        base64: bytesToBase64(new Uint8Array(buffer)),
        ext: file.name.split('.').pop() ?? 'png',
        width,
        height
      })
    } catch (error) {
      reportError(`Could not read that image: ${errorMessage(error)}`)
    }
  }

  const create = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    try {
      let options = {}
      if (picked) {
        // Asset first: a failed upload leaves no blank map behind, where the
        // other order would. An orphaned asset on a failed create is harmless
        // and already happens when an image is deleted out of a document.
        const asset = await attempt(
          invoke('doc:writeAsset', { dataBase64: picked.base64, ext: picked.ext }),
          'Could not import the image'
        )
        if (!asset) return
        options = { background: asset.path, ...fitToMapBox(picked.width, picked.height) }
      }
      const map = await useMapStore.getState().create(trimmed, options)
      if (map) onClose()
    } finally {
      setBusy(false)
    }
  }

  useModalFocusTrap(formRef)

  const dialog = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <form
        ref={formRef}
        role="dialog"
        aria-modal="true"
        aria-label="New map"
        data-testid="new-map-dialog"
        className="flex w-[24rem] flex-col gap-2 rounded border border-border bg-surface p-3"
        onSubmit={(event) => {
          event.preventDefault()
          void create()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose()
        }}
      >
        <h2 className="text-[13px] text-text">New map</h2>
        <label className="flex flex-col gap-1 text-[12px] text-muted">
          <span>Name</span>
          <TextInput
            autoFocus
            data-testid="new-map-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        <div className="flex flex-col gap-1 text-[12px] text-muted">
          <span>Background image</span>
          {picked ? (
            <div className="flex items-center gap-2">
              <img src={picked.preview} alt="" className="h-12 w-12 rounded border border-border object-cover" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-text">{picked.name}</p>
                <p className="text-faint">
                  {picked.width}×{picked.height}
                </p>
              </div>
              <button
                type="button"
                className="pub-focus-ring text-[12px] text-muted hover:text-text"
                onClick={() => setPicked(null)}
              >
                Remove
              </button>
            </div>
          ) : (
            <button
              type="button"
              data-testid="new-map-choose-image"
              className="pub-focus-ring h-7 self-start rounded border border-border px-3 text-[12px] text-muted hover:bg-surface-3 hover:text-text"
              onClick={() => fileInput.current?.click()}
            >
              Choose image…
            </button>
          )}
          <p className="text-[11px] text-faint">Leave the image empty to sketch from scratch.</p>
          <input
            ref={fileInput}
            data-testid="new-map-file"
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void pick(file)
              event.target.value = ''
            }}
          />
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            data-testid="new-map-cancel"
            className="pub-focus-ring h-7 rounded border border-border px-3 text-[12px] text-muted hover:bg-surface-3 hover:text-text"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            data-testid="new-map-create"
            disabled={!name.trim() || busy}
            className={cx(
              'pub-focus-ring h-7 rounded px-3 text-[12px]',
              'bg-accent-soft text-accent hover:brightness-110 disabled:opacity-40'
            )}
          >
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  )

  return createPortal(dialog, ownerDocument?.body ?? document.body)
}
