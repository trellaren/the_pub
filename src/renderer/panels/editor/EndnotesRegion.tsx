import { useEffect, useState } from 'react'
import type { Editor } from '@tiptap/core'
import type { PmDoc } from '@shared/model/document.js'
import { listFootnotes } from '@shared/pm/footnotes.js'
import { findFootnotePos, setFootnoteOpen } from './extensions/footnote.js'

/**
 * A read-only list of every footnote in the document, in order, shown below
 * the manuscript the way Word shows endnotes at the end rather than the foot
 * of a page — there is no pagination (Phase 7) to put them at the bottom of
 * yet. Clicking an entry opens the live footnote in place, the same
 * popover-editing surface its marker in the text opens.
 */
export function EndnotesRegion({ editor, width }: { editor: Editor; width: string }) {
  const [, force] = useState(0)

  useEffect(() => {
    const update = (): void => force((tick) => tick + 1)
    editor.on('transaction', update)
    return () => {
      editor.off('transaction', update)
    }
  }, [editor])

  const entries = listFootnotes(editor.getJSON() as PmDoc)
  if (entries.length === 0) return null

  const openFootnote = (number: number): void => {
    const pos = findFootnotePos(editor.state, number)
    if (pos === null) return
    setFootnoteOpen(editor.view, pos)
    editor.chain().setTextSelection(pos + 2).scrollIntoView().run()
  }

  return (
    <div className="pub-endnotes" style={{ width, maxWidth: '100%' }}>
      <div className="pub-endnotes-title">Notes</div>
      <ol>
        {entries.map((entry) => (
          <li key={entry.number}>
            <button type="button" onClick={() => openFootnote(entry.number)}>
              {entry.text || '(empty)'}
            </button>
          </li>
        ))}
      </ol>
    </div>
  )
}
