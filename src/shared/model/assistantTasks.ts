import type { WebAccessLevel } from './webAccess.js'

/**
 * The things a writer asks the assistant for often enough to deserve a button.
 *
 * Each is a prompt the panel sends on the writer's behalf, naming the tools
 * the job wants so a small model does not have to work that out, and naming
 * the document by path so the model does not have to find it. What a task
 * *needs* decides whether its button is shown: one that works on the open
 * document is not offered when none is open, and research is not offered to
 * a writer who has kept the assistant off the web.
 */
export interface AssistantTask {
  id: string
  title: string
  needs: 'none' | 'document' | 'selection'
  /** Besides what it needs, something the writer must have allowed. */
  requires?: 'web'
  /** Whether the selected text (or the whole document) rides along with the ask. */
  attach: boolean
  prompt: (context: { docPath: string; angle: string }) => string
}

export const ASSISTANT_TASKS: AssistantTask[] = [
  {
    id: 'peer-review',
    title: 'Review this document',
    needs: 'document',
    attach: false,
    prompt: ({ docPath }) =>
      `Review ${docPath} as a peer reviewer. Read it with read_document, leave your observations as margin comments with \`comment\` on the exact passages they concern, and offer concrete rewordings with \`suggest_edit\`. Finish with two or three sentences on the whole.`
  },
  {
    id: 'address-comments',
    title: 'Address the comments',
    needs: 'document',
    attach: false,
    prompt: ({ docPath }) =>
      `List the open comments on ${docPath} with list_comments. For each one, make the change with suggest_edit where the right change is clear, and reply with reply_comment where it needs discussion. Then tell me what you did and what you left for me.`
  },
  {
    id: 'proofread',
    title: 'Proofread',
    needs: 'document',
    attach: false,
    prompt: ({ docPath }) =>
      `Proofread ${docPath} with the proofread tool, then tell me in a sentence or two what kinds of problems you found.`
  },
  {
    id: 'tighten',
    title: 'Tighten this',
    needs: 'selection',
    attach: true,
    prompt: ({ docPath }) =>
      `Rewrite the passage below to be tighter, keeping the voice and every plot detail. Offer the rewrite with suggest_edit on ${docPath}, quoting the original exactly, rather than pasting it in your reply.`
  },
  {
    id: 'continue',
    title: 'Continue the scene',
    needs: 'document',
    attach: true,
    prompt: ({ docPath }) =>
      `Continue ${docPath} from where it ends with one paragraph in the same voice. Offer it with suggest_edit (an empty find appends) so I can accept or reject it, and say in a line where you took it.`
  },
  {
    id: 'research',
    title: 'Research this',
    needs: 'selection',
    requires: 'web',
    attach: true,
    prompt: () =>
      'Research the passage below for me. Find and read reliable sources, cite the ones you actually read with cite_page, and summarise what they say with those citations. Say plainly what you could not verify. Never cite a page you did not fetch.'
  },
  {
    id: 'prompt',
    title: 'A writing prompt',
    needs: 'none',
    attach: false,
    prompt: ({ angle }) =>
      `Give me one writing prompt rooted in this project's people and places, built around this angle: ${angle}. Two sentences at most, the prompt only.`
  },
  {
    id: 'exercise',
    title: 'A writing exercise',
    needs: 'none',
    attach: false,
    prompt: () =>
      'Set me a short writing exercise for this project. Look first at the open comments on the documents (list_documents, list_comments) and the beats still at outline stage (list_beats), and aim the exercise at one of them. Say what it practises and give a clear brief.'
  },
  {
    id: 'outline-next',
    title: 'What comes next?',
    needs: 'none',
    attach: false,
    prompt: () =>
      'Read the outline with read_outline and propose the next three beats in prose: what each does for the story and where it sits. Do not create anything; this is for me to think with.'
  },
  {
    id: 'brainstorm',
    title: 'Brainstorm',
    needs: 'none',
    attach: true,
    prompt: () => 'Help me think through the following. Ask me a question if that would be more useful than an answer.'
  }
]

export interface TaskAvailability {
  hasDocument: boolean
  hasSelection: boolean
  web: WebAccessLevel
}

export function availableTasks(state: TaskAvailability): AssistantTask[] {
  return ASSISTANT_TASKS.filter((task) => {
    if (task.needs === 'document' && !state.hasDocument) return false
    if (task.needs === 'selection' && !state.hasSelection) return false
    if (task.requires === 'web' && state.web === 'none') return false
    return true
  })
}
