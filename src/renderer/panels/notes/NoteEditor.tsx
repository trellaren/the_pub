import { useEffect, useRef } from 'react'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import type { PmDoc } from '@shared/model/document.js'

/**
 * A note's body.
 *
 * The same deliberately reduced editor `EntityNotes` uses, for the same
 * reason: this is a note, not manuscript, and every extension is weight on a
 * panel that may show several notes at once.
 */
export function NoteEditor({
  noteId,
  body,
  onChange
}: {
  noteId: string
  body: PmDoc
  onChange: (body: PmDoc) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const latest = useRef(onChange)
  latest.current = onChange

  useEffect(() => {
    const element = host.current
    if (!element) return

    const editor = new Editor({
      element,
      content: body,
      extensions: [
        StarterKit.configure({ heading: false, link: false }),
        Placeholder.configure({ placeholder: 'Say what needs saying about this…' })
      ],
      editorProps: { attributes: { class: 'pub-notes' } },
      onUpdate: ({ editor: instance }) => latest.current(instance.getJSON() as PmDoc)
    })

    return () => editor.destroy()
    // Rebuilt only when the note changes: re-running on every `body` update
    // would replace the editor mid-keystroke and lose the caret.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId])

  return <div ref={host} className="rounded border border-border bg-surface-2 px-2 py-1" />
}
