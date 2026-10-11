import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { getFindState } from './extensions/findHighlight.js'
import { setFind, stepFind, replaceAll, replaceCurrent, focusCurrentMatch, clearFind } from './editorActions.js'
import { ToolbarButton, TextInput, LiveRegion } from '@renderer/ui/primitives.js'

/**
 * Remembered across the bar closing and across documents, the way a word
 * processor's find box remembers: reopening to look for the same thing again
 * is the common case.
 */
const remembered = { term: '', replacement: '' }

export function FindReplaceBar({
  editor,
  showReplace,
  onClose
}: {
  editor: Editor
  showReplace: boolean
  onClose: () => void
}) {
  const [term, setTermState] = useState(remembered.term)
  const [replacement, setReplacementState] = useState(remembered.replacement)
  const [matchCase, setMatchCase] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const [, force] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const replaceRef = useRef<HTMLInputElement>(null)

  const setTerm = (value: string): void => {
    remembered.term = value
    setTermState(value)
  }
  const setReplacement = (value: string): void => {
    remembered.replacement = value
    setReplacementState(value)
  }

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

  const replaceOne = (): void => {
    replaceCurrent(editor, replacement)
  }
  const replaceEvery = (): void => {
    const count = replaceAll(editor, replacement)
    setAnnouncement(`Replaced ${count} ${count === 1 ? 'match' : 'matches'}`)
  }

  return (
    <div className="flex shrink-0 flex-col gap-1 border-b border-border bg-surface-2 px-2 py-1.5">
      <LiveRegion text={announcement} testId="replace-live" />
      <div className="flex items-center gap-1">
        <TextInput
          ref={inputRef}
          value={term}
          placeholder="Find"
          className="max-w-64"
          data-testid="find-input"
          onChange={(event) => {
            setAnnouncement('')
            setTerm(event.target.value)
          }}
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
            ref={replaceRef}
            value={replacement}
            placeholder="Replace with"
            className="max-w-64"
            data-testid="replace-input"
            onChange={(event) => setReplacement(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                replaceOne()
                // Replacing focuses the editor to show the selection; a second
                // Enter must replace again, not split the paragraph.
                replaceRef.current?.focus()
              }
              if (event.key === 'Escape') onClose()
            }}
          />
          <ToolbarButton label="Replace" onClick={replaceOne}>
            Replace
          </ToolbarButton>
          <ToolbarButton label="Replace all" onClick={replaceEvery}>
            All
          </ToolbarButton>
          {announcement ? <span className="text-[11px] text-faint">{announcement}</span> : null}
        </div>
      ) : null}
    </div>
  )
}
