import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { getFindState } from './extensions/findHighlight.js'
import { setFind, stepFind, replaceAll, replaceCurrent, focusCurrentMatch, clearFind } from './editorActions.js'
import { ToolbarButton, TextInput } from '@renderer/ui/primitives.js'

export function FindReplaceBar({
  editor,
  showReplace,
  onClose
}: {
  editor: Editor
  showReplace: boolean
  onClose: () => void
}) {
  const [term, setTerm] = useState('')
  const [replacement, setReplacement] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [, force] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [showReplace])

  useEffect(() => {
    setFind(editor, { term, matchCase, wholeWord })
    if (term) focusCurrentMatch(editor)
  }, [editor, term, matchCase, wholeWord])

  useEffect(() => {
    const update = (): void => force((tick) => tick + 1)
    editor.on('transaction', update)
    return () => {
      editor.off('transaction', update)
    }
  }, [editor])

  // Highlights are a search artefact, not document content — drop them when the
  // bar goes away.
  useEffect(() => {
    return () => clearFind(editor)
  }, [editor])

  const found = getFindState(editor.state)
  const position = found.matches.length === 0 ? '0/0' : `${found.current + 1}/${found.matches.length}`

  return (
    <div className="flex shrink-0 flex-col gap-1 border-b border-border bg-surface-2 px-2 py-1.5">
      <div className="flex items-center gap-1">
        <TextInput
          ref={inputRef}
          value={term}
          placeholder="Find"
          className="max-w-64"
          data-testid="find-input"
          onChange={(event) => setTerm(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              stepFind(editor, event.shiftKey ? -1 : 1)
            }
            if (event.key === 'Escape') onClose()
          }}
        />
        <span className="w-14 text-center text-[11px] tabular-nums text-faint">{position}</span>
        <ToolbarButton label="Previous match" onClick={() => stepFind(editor, -1)}>
          ↑
        </ToolbarButton>
        <ToolbarButton label="Next match" onClick={() => stepFind(editor, 1)}>
          ↓
        </ToolbarButton>
        <ToolbarButton label="Match case" active={matchCase} onClick={() => setMatchCase((on) => !on)}>
          Aa
        </ToolbarButton>
        <ToolbarButton label="Whole word" active={wholeWord} onClick={() => setWholeWord((on) => !on)}>
          ab
        </ToolbarButton>
        <div className="flex-1" />
        <ToolbarButton label="Close find" onClick={onClose}>
          ✕
        </ToolbarButton>
      </div>

      {showReplace ? (
        <div className="flex items-center gap-1">
          <TextInput
            value={replacement}
            placeholder="Replace with"
            className="max-w-64"
            onChange={(event) => setReplacement(event.target.value)}
          />
          <ToolbarButton
            label="Replace"
            onClick={() => {
              replaceCurrent(editor, replacement)
              stepFind(editor, 1)
            }}
          >
            Replace
          </ToolbarButton>
          <ToolbarButton label="Replace all" onClick={() => replaceAll(editor, replacement)}>
            All
          </ToolbarButton>
        </div>
      ) : null}
    </div>
  )
}
