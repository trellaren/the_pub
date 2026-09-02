import { useEffect, useRef, useState } from 'react'
import { DockviewDefaultTab, type IDockviewPanelHeaderProps } from 'dockview-react'
import { useDocumentStore } from '@renderer/stores/documentStore.js'
import { EDITOR_PANEL_PREFIX } from '@renderer/stores/layoutStore.js'

/**
 * The tab every panel gets.
 *
 * For most panels it is dockview's own tab untouched. A tab over a document
 * adds one behaviour: double-click and the title becomes editable, committing
 * to the document's envelope — the same field the Manuscript panel and Word
 * export read. It has to be the default tab component, not a per-panel one,
 * because a layout saved by an older build restores its editor panels without
 * any `tabComponent` recorded, and those tabs must rename like new ones.
 */
export function DockTab(props: IDockviewPanelHeaderProps) {
  const panelId = props.api.id
  const docId = panelId.startsWith(EDITOR_PANEL_PREFIX)
    ? panelId.slice(EDITOR_PANEL_PREFIX.length)
    : null
  const title = useDocumentStore((store) => (docId ? store.docs[docId]?.title : undefined))
  const renameTitle = useDocumentStore((store) => store.renameTitle)
  const [draft, setDraft] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (draft !== null) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [draft])

  if (docId === null || title === undefined) return <DockviewDefaultTab {...props} />

  if (draft === null) {
    return (
      <DockviewDefaultTab
        {...props}
        onDoubleClick={(event) => {
          event.preventDefault()
          setDraft(title)
        }}
      />
    )
  }

  const commit = (): void => {
    const value = draft
    setDraft(null)
    void renameTitle(docId, value)
  }

  return (
    <div className="dv-default-tab" data-testid="tab-rename">
      <input
        ref={inputRef}
        className="pub-focus-ring h-5 w-32 rounded border border-border bg-surface-2 px-1 text-[12px] text-text"
        aria-label="Document title"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        // The tab's own pointer handling starts a drag; a click meant to place
        // the caret in the input must never begin dragging the tab.
        onPointerDown={(event) => event.stopPropagation()}
        onBlur={commit}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Enter') commit()
          if (event.key === 'Escape') setDraft(null)
        }}
      />
    </div>
  )
}
