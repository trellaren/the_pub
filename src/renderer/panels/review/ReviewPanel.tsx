import { useEffect, useState } from 'react'
import type { AssembledThread, ReviewReply } from '@shared/model/review.js'
import type { PmDoc } from '@shared/model/document.js'
import { extractPlainText } from '@shared/pm/extractText.js'
import { listSuggestions } from '@shared/pm/suggestions.js'
import { useDocumentStore, getEditor } from '@renderer/stores/documentStore.js'
import { useReviewStore } from '@renderer/stores/reviewStore.js'
import { revealBlock, setSuggesting, resolveSuggestion } from '../editor/editorActions.js'
import { PanelShell, PanelHeader, EmptyState, ToolbarButton, Checkbox } from '@renderer/ui/primitives.js'

/**
 * The review pane: everyone's comments on the active document, the suggestions
 * awaiting a verdict, and who else is reading it.
 *
 * Scoped to the last focused editor rather than the frontmost tab, the same way
 * `NotesPanel` is.
 */
export function ReviewPanel() {
  const docId = useDocumentStore((store) => store.activeDocId)
  const threads = useReviewStore((store) => (docId ? (store.threadsByDoc[docId] ?? []) : []))
  const presence = useReviewStore((store) => store.presence)
  const suggesting = useReviewStore((store) => store.suggesting)
  const me = useReviewStore((store) => store.me)

  useEffect(() => {
    void useReviewStore.getState().loadMe()
  }, [])

  useEffect(() => {
    if (!docId) return
    void useReviewStore.getState().loadForDoc(docId)
    return useReviewStore.getState().watch(docId)
  }, [docId])

  if (!docId) {
    return (
      <PanelShell>
        <PanelHeader>Review</PanelHeader>
        <EmptyState title="Open a document to review it" />
      </PanelShell>
    )
  }

  const editor = getEditor(docId)
  const suggestions = editor ? listSuggestions(editor.getJSON() as PmDoc) : []

  return (
    <PanelShell>
      <PanelHeader>Review</PanelHeader>
      <div className="flex flex-col gap-1 border-b border-border px-2 py-1">
        <Checkbox
          label="Suggest changes instead of making them"
          checked={suggesting}
          onChange={(checked) => {
            useReviewStore.getState().setSuggesting(checked)
            if (editor) setSuggesting(editor, checked, me?.id ?? '')
          }}
        />
        {presence.length > 0 ? (
          <p className="text-[11px] text-faint">
            Also here: {presence.map((beat) => beat.name || beat.authorId).join(', ')}
          </p>
        ) : null}
      </div>

      <div className="flex-1 overflow-auto">
        {suggestions.length > 0 ? (
          <section className="border-b border-border/60">
            <h3 className="px-2 py-1 text-[11px] uppercase tracking-wide text-faint">
              Suggested edits
            </h3>
            {suggestions.map((suggestion, index) => (
              <div key={index} className="flex items-center gap-1 px-2 py-1 text-[12px]">
                <button
                  type="button"
                  onClick={() => editor && revealBlock(editor, suggestion.blockIndex, suggestion.text)}
                  className="flex-1 truncate text-left hover:text-text"
                  style={{ color: useReviewStore.getState().describe(suggestion.authorId).color }}
                  title={suggestion.text}
                >
                  {suggestion.mark === 'insertion' ? '+ ' : '− '}
                  {suggestion.text}
                </button>
                <ToolbarButton
                  label="Accept"
                  onClick={() => editor && resolveSuggestion(editor, true, suggestion)}
                >
                  ✓
                </ToolbarButton>
                <ToolbarButton
                  label="Reject"
                  onClick={() => editor && resolveSuggestion(editor, false, suggestion)}
                >
                  ✕
                </ToolbarButton>
              </div>
            ))}
          </section>
        ) : null}

        {threads.length === 0 ? (
          <EmptyState
            title="No comments yet"
            hint="Select some text and add one from the toolbar."
          />
        ) : (
          threads.map((thread) => (
            <ThreadCard key={thread.id} docId={docId} thread={thread} editor={editor ?? null} />
          ))
        )}
      </div>
    </PanelShell>
  )
}

function ThreadCard({
  docId,
  thread,
  editor
}: {
  docId: string
  thread: AssembledThread
  editor: ReturnType<typeof getEditor> | null
}) {
  const [draft, setDraft] = useState('')
  const me = useReviewStore((store) => store.me)
  const author = useReviewStore((store) => store.describe(thread.authorId))
  const store = useReviewStore.getState()

  return (
    <div className="border-b border-border/60 p-2">
      <div className="flex items-start gap-1">
        <span
          className="mt-1 h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: author.color }}
          title={author.name}
        />
        <button
          type="button"
          onClick={() => editor && revealBlock(editor, thread.blockIndex, thread.anchorText)}
          disabled={!editor || thread.orphaned}
          className="flex-1 truncate text-left text-[12px] italic text-muted hover:text-text disabled:hover:text-muted"
          title={thread.anchorText}
        >
          “{thread.anchorText}”
        </button>
        {thread.authorId === me?.id ? (
          <ToolbarButton
            label="Delete comment"
            onClick={() => void store.removeThread(docId, thread.id)}
          >
            ✕
          </ToolbarButton>
        ) : null}
      </div>

      {thread.orphaned ? (
        <p className="my-1 rounded border border-border bg-surface-2 px-2 py-1 text-[11px] text-faint">
          This comment's text is no longer in the document.
        </p>
      ) : null}

      <p className="whitespace-pre-wrap text-[12px]">{extractPlainText(thread.body)}</p>

      {thread.replies.map((reply) => (
        <ReplyRow key={reply.id} docId={docId} reply={reply} />
      ))}

      <div className="mt-1 flex gap-1">
        <input
          value={draft}
          placeholder="Reply…"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || !draft.trim()) return
            void store.reply(docId, thread.id, draft.trim())
            setDraft('')
          }}
          className="flex-1 rounded border border-border bg-surface px-1 py-0.5 text-[12px]"
        />
        {/* Anyone may resolve, including someone else's thread — it is settled
            by whoever acted on it, not by whoever raised it. */}
        <Checkbox
          label="Resolved"
          checked={thread.status === 'resolved'}
          onChange={(checked) =>
            void store.setStatus(docId, thread.id, checked ? 'resolved' : 'open')
          }
        />
      </div>
    </div>
  )
}

function ReplyRow({ docId, reply }: { docId: string; reply: ReviewReply }) {
  const me = useReviewStore((store) => store.me)
  const author = useReviewStore((store) => store.describe(reply.authorId))
  return (
    <div className="mt-1 flex items-start gap-1 border-l-2 pl-2" style={{ borderColor: author.color }}>
      <p className="flex-1 whitespace-pre-wrap text-[12px]">
        <span className="text-faint">{author.name}: </span>
        {extractPlainText(reply.body)}
      </p>
      {reply.authorId === me?.id ? (
        <ToolbarButton
          label="Delete reply"
          onClick={() => void useReviewStore.getState().removeReply(docId, reply.id)}
        >
          ✕
        </ToolbarButton>
      ) : null}
    </div>
  )
}
