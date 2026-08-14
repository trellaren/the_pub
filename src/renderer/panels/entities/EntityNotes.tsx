import { useEffect, useRef } from 'react'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import type { PmDoc } from '@shared/model/document.js'

/**
 * Long-form notes on a record.
 *
 * A deliberately reduced editor — StarterKit and a placeholder, nothing else.
 * These are notes, not manuscript: named styles, tables and page geometry would
 * all be noise here, and every extension is weight on a panel that may have one
 * instance per open record.
 *
 * **Notes are not scanned for mentions.** Worth saying out loud, because it is
 * the first thing anyone assumes works: the index covers `.pubdoc` files, and
 * notes live inside entities.json.
 */
export function EntityNotes({
  entityId,
  notes,
  onChange
}: {
  entityId: string
  notes: PmDoc
  onChange: (notes: PmDoc) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const latest = useRef(onChange)
  latest.current = onChange

  useEffect(() => {
    const element = host.current
    if (!element) return

    const editor = new Editor({
      element,
      content: notes,
      extensions: [
        StarterKit.configure({ heading: { levels: [2, 3] }, link: false }),
        Placeholder.configure({ placeholder: 'Notes, history, anything worth remembering…' })
      ],
      editorProps: { attributes: { class: 'pub-notes' } },
      onUpdate: ({ editor: instance }) => latest.current(instance.getJSON() as PmDoc)
    })

    return () => editor.destroy()
    // Rebuilt only when the selected record changes: re-running on every `notes`
    // change would replace the editor mid-keystroke and lose the caret.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId])

  return <div ref={host} className="mt-1 rounded border border-border bg-surface-2 px-2 py-1" />
}
