import { useEffect } from 'react'
import { useChatStore, listenForRetrievalProgress } from '@renderer/stores/chatStore.js'
import { ToolbarButton, SectionTitle } from '@renderer/ui/primitives.js'

/**
 * The retrieval index: how much of the manuscript can be searched by meaning.
 *
 * Coverage is shown as a number rather than a tick, because partial is the
 * normal state and the difference matters: an assistant answering "you never
 * mention the harbour" from a third of the book is confidently wrong, and the
 * only defence is that the writer can see how much of it was searched.
 *
 * Building is a button rather than something that happens on its own. The index
 * fills quietly when it is free to — after a reply, while a local model is
 * already loaded — but loading gigabytes of weights, or posting a manuscript to
 * a paid API, is not something to do because a project was opened.
 */
export function RetrievalManager() {
  const retrieval = useChatStore((store) => store.retrieval)

  useEffect(() => {
    void useChatStore.getState().refreshRetrieval()
  }, [])

  useEffect(() => listenForRetrievalProgress(), [])

  if (!retrieval) return null

  const { embedded, total, building, unavailable, error } = retrieval
  const complete = total > 0 && embedded >= total
  const percent = total === 0 ? 0 : Math.round((embedded / total) * 100)

  return (
    <div data-testid="retrieval-manager">
      <SectionTitle>Search by meaning</SectionTitle>

      <p className="mb-1 text-[11px] text-muted" data-testid="retrieval-coverage">
        {total === 0
          ? 'Nothing indexed yet — this project has no documents.'
          : complete
            ? `All ${total} passages are indexed.`
            : `${embedded} of ${total} passages indexed (${percent}%).`}
      </p>

      {unavailable ? (
        <p className="mb-1 text-[11px] text-faint" data-testid="retrieval-unavailable">
          {unavailable}
        </p>
      ) : null}

      {error ? (
        <p className="mb-1 text-[11px] text-danger" data-testid="retrieval-error">
          {error}
        </p>
      ) : null}

      {building ? (
        <ToolbarButton
          label="Stop building the retrieval index"
          data-testid="retrieval-stop"
          onClick={() => void useChatStore.getState().cancelRetrieval()}
        >
          Stop indexing
        </ToolbarButton>
      ) : (
        <ToolbarButton
          label="Index this project so the assistant can search it by meaning"
          data-testid="retrieval-build"
          disabled={complete || total === 0}
          onClick={() => void useChatStore.getState().buildRetrieval()}
        >
          {embedded > 0 ? 'Finish indexing' : 'Build the index'}
        </ToolbarButton>
      )}

      <p className="mt-1 text-[10px] text-faint">
        Lets the assistant find passages by what they are about rather than by the words in them.
        The index is a cache — deleting it costs nothing but the time to rebuild.
      </p>
    </div>
  )
}
