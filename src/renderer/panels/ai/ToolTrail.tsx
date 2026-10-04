import type { ToolCall } from '@shared/model/ai.js'
import { useDocumentStore } from '@renderer/stores/documentStore.js'
import { useLayoutStore } from '@renderer/stores/layoutStore.js'
import { cx } from '@renderer/ui/primitives.js'
import { documentPathOf } from './context.js'

/**
 * What the agent did, above the answer it did it for.
 *
 * A call that touched a document links to it: a suggestion or a comment is
 * something to go and look at, and the panel that judges it is the editor's
 * Review panel, not this one.
 */
export function ToolTrail({ calls }: { calls: ToolCall[] }) {
  return (
    <ul className="mb-1 border-l-2 border-border pl-2" data-testid="tool-trail">
      {calls.map((call) => {
        const path = documentPathOf(call)
        return (
          <li key={call.id} className={cx('text-[10px]', call.ok ? 'text-faint' : 'text-danger')}>
            {call.result || call.name}
            {path && call.ok ? (
              <button
                type="button"
                className="ml-1 text-accent hover:underline"
                onClick={() => void openDocumentFromTrail(path, call.name)}
                aria-label={`Open ${path}`}
              >
                open
              </button>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

async function openDocumentFromTrail(path: string, tool: string): Promise<void> {
  const docId = await useDocumentStore.getState().openPath(path)
  if (!docId) return
  const state = useDocumentStore.getState().docs[docId]
  if (state) useLayoutStore.getState().openEditor(docId, state.path, state.title)
  // A comment or a suggestion is judged in the Review panel, so it comes along.
  if (tool !== 'read_document') useLayoutStore.getState().showPanel('review', 'Review')
}
