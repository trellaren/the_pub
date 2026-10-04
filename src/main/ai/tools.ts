import { z } from 'zod'
import { ulid } from 'ulid'
import type { ProjectSession } from '../services/projectSession.js'
import type { SemanticHit } from '../services/searchIndexService.js'
import type { AuthorProfile } from '../../shared/model/author.js'
import { extractPlainText, extractBlocks } from '../../shared/pm/extractText.js'
import {
  PROOFREAD_KINDS,
  MAX_PROOFREAD_CALLS,
  chunkBlocks,
  proofreadPrompt,
  parseFindings,
  describeFindings,
  type PlacedFinding,
  type ProofreadKind
} from './proofread.js'
import { findTextOccurrences } from '../../shared/pm/anchors.js'
import type { AssistantEdit, AssistantEditOp } from '../../shared/pm/assistantEdits.js'
import { isTrivial, type WritePolicy } from '../../shared/model/provenance.js'
import type { WebSearchHit } from '../../shared/model/webAccess.js'
import type { Capture } from '../../shared/model/research.js'
import { applyCaptureToCslFields, type CaptureResult, type CaptureFailure } from '../research/capture.js'
import type { WebGate } from './webGate.js'
import {
  ensembleConstraintsSchema,
  draftedRecordSchema,
  validateEnsemble,
  describeFailures
} from '../../shared/model/ensemble.js'
import type { ToolSpec } from './providers.js'

/**
 * What the agent can do.
 *
 * Small, read-mostly, and every entry a thin wrapper over a service that
 * already exists — the agent gets no capability the app did not already have,
 * it only gets to ask for it.
 *
 * The rule the whole design rests on: **nothing here writes to a document.**
 * `suggest_edit` describes a change as an `AssistantEdit` and hands it to
 * whoever holds the document, where it lands as Phase 9 suggestion marks for
 * the writer to judge. Accept/reject, attribution, undo and the Word
 * round-trip are inherited from there rather than rebuilt here.
 */

const MAX_SEARCH_HITS = 12
const MAX_DOCUMENT_CHARS = 12_000
const MAX_PAGE_CHARS = 12_000

/** What a semantic search came back with, and how much of the book it covered. */
export interface RetrievalResult {
  hits: SemanticHit[]
  embedded: number
  total: number
}

export interface ToolContext {
  session: ProjectSession
  /** Who the assistant is in this project, for every mark and record it stamps. */
  assistant: AuthorProfile
  /** The run these calls belong to, recorded on every edit for provenance. */
  runId: string
  model: string
  /** The writer's standing choice: suggest everything, apply trivial fixes, or apply directly. */
  writePolicy: WritePolicy
  /** What the writer has allowed on the web; see `webGate.ts`. */
  web: WebGate
  /** A web search, when `web.canSearch`. */
  search?: (query: string, limit: number) => Promise<{ ok: true; hits: WebSearchHit[] } | { ok: false; reason: string }>
  /** Fetch one page as readable text, through the gate. */
  fetchPage?: (url: string) => Promise<CaptureResult | CaptureFailure>
  /**
   * Pages fetched during this run, by URL. `cite_page` refuses a URL that is
   * not here: a citation is only ever written for a page the assistant has
   * actually read, which is the whole difference between this and `add_source`.
   */
  captures: Map<string, Capture>
  /** Collects edits as they are described, so the loop can stream them out. */
  onEdit: (edit: AssistantEdit) => void
  /** A comment or reply landed on this document; the Review panel should reload. */
  onReviewChanged: (docId: string) => void
  /**
   * One plain request to the same model, outside the tool loop.
   *
   * For tools whose work *is* a model call — proofreading a chapter chunk by
   * chunk — rather than a lookup. Bound by the loop to the run's settings, key
   * and abort signal, so a tool cannot reach a provider the writer did not
   * choose or outlive a run they cancelled.
   */
  complete: (system: string, user: string, maxTokens: number) => Promise<string>
  /**
   * How many times each ensemble has been attempted in this run, so a group
   * that fails its constraints is redrafted once and then written with the
   * failures named rather than retried until the step budget runs out. Lives on
   * the run, not the call: two calls are the whole point of counting.
   */
  ensembleAttempts: Map<string, number>
  /**
   * Whether this run has read text from outside the project. Shared by every
   * call in the run, because a page fetched in one call can carry instructions
   * the model acts on in the next: once set, every edit lands as a suggestion
   * whatever the writer's policy, so injected text can never write directly.
   */
  taint: { tainted: boolean }
  /** Search by meaning. Absent when this project has no retrieval index. */
  findPassages?: (query: string, limit: number) => Promise<RetrievalResult>
}

export interface ToolResult {
  /** What goes back to the model. */
  content: string
  /** One line for the transcript, which is a person's record rather than the model's. */
  summary: string
  ok: boolean
}

interface ToolDef<S extends z.ZodType> {
  name: string
  description: string
  args: S
  run: (args: z.infer<S>, context: ToolContext) => Promise<ToolResult>
}

function define<S extends z.ZodType>(def: ToolDef<S>): ToolDef<z.ZodType> {
  return def as unknown as ToolDef<z.ZodType>
}

const searchManuscript = define({
  name: 'search_manuscript',
  description:
    'Search the full text of every document in this project. Returns matching passages with the document each came from. Use this before answering anything about what the manuscript says.',
  args: z.object({
    query: z.string().describe('Words to search for.')
  }),
  run: async ({ query }, { session }) => {
    const hits = session.search
      .query({ text: query, limit: MAX_SEARCH_HITS, matchCase: false, wholeWord: false })
      .slice(0, MAX_SEARCH_HITS)

    if (hits.length === 0) {
      return { ok: true, content: `No passages match "${query}".`, summary: `Searched for "${query}" — nothing found` }
    }

    const content = hits
      .map((hit) => `${hit.path} (block ${hit.blockIndex}): ${hit.snippet}`)
      .join('\n\n')
    return {
      ok: true,
      content,
      summary: `Searched for "${query}" — ${hits.length} passage${hits.length === 1 ? '' : 's'}`
    }
  }
})

const findPassages = define({
  name: 'find_passages',
  description:
    'Find passages by what they are about rather than by the words in them. Use this for questions like "where do I describe the harbour" or "which scenes are about grief", where the manuscript may never use the word you searched for. Use search_manuscript instead when you need an exact phrase.',
  args: z.object({
    query: z.string().describe('What you are looking for, in a phrase or a sentence.')
  }),
  run: async ({ query }, { findPassages: find }) => {
    if (!find) {
      return {
        ok: false,
        content: 'This project has no retrieval index. Use search_manuscript instead.',
        summary: 'No retrieval index'
      }
    }

    const { hits, embedded, total } = await find(query, MAX_SEARCH_HITS)
    // A partial index is the normal state, and the model must be told: an
    // answer of "you never mention it" drawn from a third of the book is
    // confidently wrong in a way nobody downstream can catch.
    const coverage =
      embedded >= total
        ? ''
        : `\n\n(Only ${embedded} of ${total} passages are indexed for meaning, so this search did not cover the whole project.)`

    if (hits.length === 0) {
      return {
        ok: true,
        content: `Nothing reads as being about "${query}".${coverage}`,
        summary: `Searched by meaning for "${query}" — nothing found`
      }
    }

    const content =
      hits
        .map((hit) => `${hit.path} (block ${hit.blockIndex}): ${hit.text.slice(0, 400)}`)
        .join('\n\n') + coverage
    return {
      ok: true,
      content,
      summary: `Searched by meaning for "${query}" — ${hits.length} passage${hits.length === 1 ? '' : 's'}`
    }
  }
})

const readDocument = define({
  name: 'read_document',
  description:
    'Read the full text of one document, given its project-relative path (as returned by search_manuscript).',
  args: z.object({
    path: z.string().describe('Project-relative path, ending in .pubdoc')
  }),
  run: async ({ path }, { session }) => {
    try {
      const loaded = await session.documents.read(path)
      const text = extractPlainText(loaded.doc.content)
      // Truncated rather than refused: a chapter that overruns is still worth
      // most of its content to the model, and refusing would send it looking
      // for another way in.
      const clipped =
        text.length > MAX_DOCUMENT_CHARS
          ? `${text.slice(0, MAX_DOCUMENT_CHARS)}\n\n[…truncated…]`
          : text
      return {
        ok: true,
        content: `# ${loaded.doc.title}\n\n${clipped}`,
        summary: `Read ${path}`
      }
    } catch {
      return { ok: false, content: `No document at ${path}.`, summary: `Could not read ${path}` }
    }
  }
})

const listRecords = define({
  name: 'list_records',
  description:
    'List the story records in this project — characters, locations and any other kinds the project defines — with their names and summaries.',
  args: z.object({
    kind: z.string().default('').describe('Optional kind id to filter by, e.g. "character".')
  }),
  run: async ({ kind }, { session }) => {
    const all = session.entities.snapshot().entities
    const records = kind ? all.filter((entity) => entity.kind === kind) : all
    if (records.length === 0) {
      return { ok: true, content: 'This project has no records.', summary: 'Listed records — none' }
    }
    const content = records
      .map((entity) => `- ${entity.name} (${entity.kind}): ${entity.summary || 'no summary'}`)
      .join('\n')
    return { ok: true, content, summary: `Listed ${records.length} record${records.length === 1 ? '' : 's'}` }
  }
})

const readRecord = define({
  name: 'read_record',
  description: 'Read one story record in full, including its notes, by name.',
  args: z.object({ name: z.string() }),
  run: async ({ name }, { session }) => {
    const wanted = name.trim().toLowerCase()
    const entity = session.entities
      .snapshot()
      .entities.find(
        (candidate) =>
          candidate.name.toLowerCase() === wanted ||
          candidate.aliases.some((alias) => alias.text.toLowerCase() === wanted)
      )
    if (!entity) return { ok: false, content: `No record called "${name}".`, summary: `No record "${name}"` }

    const notes = entity.notes ? extractPlainText(entity.notes) : ''
    return {
      ok: true,
      content: [
        `Name: ${entity.name}`,
        entity.aliases.length
          ? `Also known as: ${entity.aliases.map((alias) => alias.text).join(', ')}`
          : '',
        `Kind: ${entity.kind}`,
        entity.summary ? `Summary: ${entity.summary}` : '',
        notes ? `Notes:\n${notes}` : ''
      ]
        .filter(Boolean)
        .join('\n'),
      summary: `Read the record for ${entity.name}`
    }
  }
})

const listDocuments = define({
  name: 'list_documents',
  description: 'List the documents in this project, in manuscript order where one is defined.',
  args: z.object({}),
  run: async (_args, { session }) => {
    const view = await session.manuscript.view()
    const rows = view.nodes
      .filter((node) => node.kind === 'document' && !node.missing)
      .map((node) => `- ${node.title} (${node.resolvedPath ?? node.path})`)
    if (rows.length === 0) {
      return { ok: true, content: 'No documents are in the manuscript yet.', summary: 'Listed documents — none' }
    }
    return { ok: true, content: rows.join('\n'), summary: `Listed ${rows.length} documents` }
  }
})

/**
 * Describe an edit in the coordinates `applyAssistantEdit` wants.
 *
 * Located by quoted text rather than offsets the model would have to count:
 * models quote reliably and count badly. The quote must be unique, because a
 * change to "the second one" is a change to whichever one the code found first.
 */
export function describeEdit(
  context: ToolContext,
  docId: string,
  docPath: string,
  ops: AssistantEditOp[],
  mode: AssistantEdit['mode'] = 'suggest'
): AssistantEdit {
  return {
    id: ulid(),
    runId: context.runId,
    docId,
    docPath,
    authorId: context.assistant.id,
    model: context.model,
    at: new Date().toISOString(),
    mode,
    ops
  }
}

/**
 * Which way one change lands, under the writer's policy.
 *
 * Decided here, in main, per change — never by the model, which is told only
 * what happened. `trivial` is the caller's judgement of this particular
 * change (a spelling fix, a comma); it only matters under `direct-trivial`.
 */
export function modeFor(policy: WritePolicy, trivial: boolean, tainted = false): AssistantEdit['mode'] {
  if (tainted) return 'suggest'
  if (policy === 'direct') return 'direct'
  if (policy === 'direct-trivial' && trivial) return 'direct'
  return 'suggest'
}

/**
 * Mark the run as having read outside text, and say so to the model when that
 * changes what its edits will do.
 */
function taintWith(context: ToolContext, content: string): string {
  const already = context.taint.tainted
  context.taint.tainted = true
  if (already || context.writePolicy === 'suggest') return content
  return `${content}\n\n(This came from outside the project. From now on in this conversation, every edit you make will be offered to the author as a tracked-change suggestion rather than applied.)`
}

/** Split ops by the mode each should land in, so one call can suggest some and apply others. */
function emitByMode(
  context: ToolContext,
  docId: string,
  docPath: string,
  items: { op: AssistantEditOp; trivial: boolean }[]
): { direct: number; suggested: number } {
  const landsDirect = (item: { trivial: boolean }) =>
    modeFor(context.writePolicy, item.trivial, context.taint.tainted) === 'direct'
  const direct = items.filter(landsDirect).map((item) => item.op)
  const suggested = items.filter((item) => !landsDirect(item)).map((item) => item.op)
  if (direct.length) context.onEdit(describeEdit(context, docId, docPath, direct, 'direct'))
  if (suggested.length) context.onEdit(describeEdit(context, docId, docPath, suggested, 'suggest'))
  return { direct: direct.length, suggested: suggested.length }
}

const suggestEdit = define({
  name: 'suggest_edit',
  description:
    'Suggest a change to a document. This does NOT change the text — it appears as a tracked change the author accepts or rejects. Quote the existing text exactly in `find`, within one paragraph, with enough words that it occurs only once. Leave `find` empty to add new paragraphs at the end.',
  args: z.object({
    path: z.string().describe('Project-relative path of the document to change.'),
    find: z.string().default('').describe('The exact existing text to replace. Empty to append.'),
    replace: z.string().describe('What to put in its place.'),
    reason: z.string().default('').describe('Why, in one sentence.')
  }),
  run: async ({ path, find, replace, reason }, context) => {
    let loaded
    try {
      loaded = await context.session.documents.read(path)
    } catch {
      return { ok: false, content: `No document at ${path}.`, summary: `Could not read ${path}` }
    }

    if (!find.trim()) {
      if (!replace.trim()) return { ok: false, content: 'There is nothing to add.', summary: 'Empty suggestion' }
      const landed = emitByMode(context, loaded.doc.docId, path, [{ op: { kind: 'append', text: replace, reason }, trivial: false }])
      return landed.direct
        ? { ok: true, content: 'The addition was written into the document, marked as yours. Do not repeat it.', summary: `Added to ${loaded.doc.title}` }
        : {
            ok: true,
            content: 'The addition was suggested to the author as a tracked change. Do not repeat it.',
            summary: `Suggested an addition to ${loaded.doc.title}`
          }
    }

    // Checked against the document before it is offered: a suggestion quoting
    // text that is not there cannot be placed, and finding that out after the
    // author has read it is finding out too late.
    const occurrences = findTextOccurrences(loaded.doc.content, find.trim())
    if (occurrences.length === 0) {
      return {
        ok: false,
        content: `That exact text is not in ${path}. Quote it exactly as it appears, within one paragraph.`,
        summary: `Suggested an edit to ${loaded.doc.title} that did not match`
      }
    }
    if (occurrences.length > 1) {
      return {
        ok: false,
        content: `"${find.trim()}" occurs ${occurrences.length} times in ${path}. Include more of the surrounding words so it occurs once.`,
        summary: `Suggested an ambiguous edit to ${loaded.doc.title}`
      }
    }

    const [where] = occurrences
    const landed = emitByMode(context, loaded.doc.docId, path, [
      {
        op: { kind: 'replace', blockIndex: where!.blockIndex, start: where!.start, end: where!.end, text: replace, reason },
        trivial: isTrivial(find, replace)
      }
    ])
    return landed.direct
      ? { ok: true, content: 'The change was made in the document, marked as yours. Do not repeat it.', summary: `Changed ${loaded.doc.title}` }
      : {
          ok: true,
          content: 'The change was suggested to the author as a tracked change they will accept or reject. Do not repeat it.',
          summary: `Suggested an edit to ${loaded.doc.title}`
        }
  }
})

/*
 * The planning tools.
 *
 * Read-only views of the storyboard, so "what comes next" and "set me an
 * exercise" can be asked of this book rather than of a book. There is no
 * tool that writes a beat: beats have no `provisional` flag, so the service
 * could not enforce Phase 15's rule that a tool changes only what it drafted
 * — and a rule the service cannot enforce is a request, not a rule.
 */

const listBeats = define({
  name: 'list_beats',
  description:
    'List the story beats on the storyboard — title, summary, when it happens, which document it is in, who is in it, and how far along it is (outline, draft, revised, done).',
  args: z.object({
    status: z.enum(['outline', 'draft', 'revised', 'done', 'all']).default('all')
  }),
  run: async ({ status }, { session }) => {
    const { beats, columns } = session.beats.snapshot()
    const names = new Map(session.entities.snapshot().entities.map((entity) => [entity.id, entity.name]))
    const columnName = new Map(columns.map((column) => [column.id, column.name]))
    const wanted = beats.filter((beat) => status === 'all' || beat.status === status)
    if (wanted.length === 0) {
      return { ok: true, content: `No ${status === 'all' ? '' : `${status} `}beats.`, summary: `Listed beats — none` }
    }
    const content = wanted
      .map((beat) => {
        const cast = beat.entityIds.map((id) => names.get(id)).filter(Boolean).join(', ')
        return [
          `- ${beat.title} [${beat.status}]${columnName.get(beat.columnId) ? ` · ${columnName.get(beat.columnId)}` : ''}${beat.when.label ? ` · when: ${beat.when.label}` : ''}`,
          beat.summary ? `  ${beat.summary}` : '',
          cast ? `  with: ${cast}` : '',
          beat.docId ? `  in document ${session.search.resolvePath(beat.docId) ?? beat.docId}` : ''
        ]
          .filter(Boolean)
          .join('\n')
      })
      .join('\n')
    return { ok: true, content, summary: `Listed ${wanted.length} beat${wanted.length === 1 ? '' : 's'}` }
  }
})

const readOutline = define({
  name: 'read_outline',
  description:
    'The shape of the book: the manuscript in order (parts and documents, with word counts) and the storyboard columns with their beats. Use it before proposing what comes next.',
  args: z.object({}),
  run: async (_args, { session }) => {
    const view = session.manuscript.view()
    const manuscript = view.nodes
      .map((node) =>
        node.kind === 'part'
          ? `${node.title}`
          : `  ${node.title}${node.missing ? ' (missing)' : ''}${node.resolvedPath ? ` — ${node.resolvedPath}` : ''}`
      )
      .join('\n')
    const { beats, columns } = session.beats.snapshot()
    const board = [...columns]
      .sort((a, b) => a.order - b.order)
      .map((column) => {
        const inColumn = beats.filter((beat) => beat.columnId === column.id).sort((a, b) => a.order - b.order)
        return `${column.name}:\n${inColumn.length ? inColumn.map((beat) => `  - ${beat.title} [${beat.status}]${beat.summary ? ` — ${beat.summary}` : ''}`).join('\n') : '  (empty)'}`
      })
      .join('\n')
    return {
      ok: true,
      content: `Manuscript:\n${manuscript || '  (no documents yet)'}\n\nStoryboard:\n${board || '  (no columns)'}`,
      summary: 'Read the outline'
    }
  }
})

/*
 * The review tools.
 *
 * Comments are the other half of a peer review, and they already have a home:
 * `ReviewService`'s one-file-per-(document, author) threads, which the
 * assistant writes under its own id. A comment is anchored the way a person's
 * is — an `anchor` mark delivered through the same edit routing as a
 * suggestion — so orphan recovery, the panel and the Word export all treat it
 * as an ordinary thread by someone called Assistant.
 */

function locateQuote(
  content: Parameters<typeof findTextOccurrences>[0],
  quote: string,
  path: string
): { blockIndex: number; start: number; end: number } | ToolResult {
  const wanted = quote.trim()
  if (!wanted) return { ok: false, content: 'Quote the passage the comment is about.', summary: 'Empty quote' }
  const occurrences = findTextOccurrences(content, wanted)
  if (occurrences.length === 0) {
    return {
      ok: false,
      content: `That exact text is not in ${path}. Quote it exactly as it appears, within one paragraph.`,
      summary: `Quoted text not found in ${path}`
    }
  }
  if (occurrences.length > 1) {
    return {
      ok: false,
      content: `"${wanted}" occurs ${occurrences.length} times in ${path}. Include more of the surrounding words so it occurs once.`,
      summary: `Ambiguous quote in ${path}`
    }
  }
  return occurrences[0]!
}

const comment = define({
  name: 'comment',
  description:
    'Leave a review comment on a passage of a document, as a reviewer would in the margin. It appears in the Review panel attached to the quoted text. Quote the passage exactly, within one paragraph, with enough words that it occurs only once. Use suggest_edit instead when you have a concrete rewording.',
  args: z.object({
    path: z.string().describe('Project-relative path of the document.'),
    quote: z.string().describe('The exact passage the comment is about.'),
    text: z.string().min(1).describe('The comment itself.')
  }),
  run: async ({ path, quote, text }, context) => {
    let loaded
    try {
      loaded = await context.session.documents.read(path)
    } catch {
      return { ok: false, content: `No document at ${path}.`, summary: `Could not read ${path}` }
    }
    const where = locateQuote(loaded.doc.content, quote, path)
    if ('ok' in where) return where

    // The thread first, then the mark. A mark that never lands leaves a thread
    // the next reconcile marks orphaned — with its text intact and recoverable,
    // which is the failure the review system was already built to survive. A
    // mark with no thread would be an anchor pointing at nothing.
    const anchorId = ulid()
    const thread = await context.session.reviews.createThread(
      loaded.doc.docId,
      anchorId,
      quote.trim(),
      where.blockIndex,
      { as: context.assistant, text }
    )
    context.onEdit(
      describeEdit(context, loaded.doc.docId, path, [
        { kind: 'anchor', blockIndex: where.blockIndex, start: where.start, end: where.end, anchorId }
      ])
    )
    context.onReviewChanged(loaded.doc.docId)
    return {
      ok: true,
      content: `Comment ${thread.id} was left on "${quote.trim()}". The author will see it in the Review panel.`,
      summary: `Commented on ${loaded.doc.title}: "${quote.trim().slice(0, 40)}${quote.trim().length > 40 ? '…' : ''}"`
    }
  }
})

const listComments = define({
  name: 'list_comments',
  description:
    'List the review comments on a document — yours and every other reviewer\'s — with their ids, status, the passage each is attached to, and any replies.',
  args: z.object({
    path: z.string().describe('Project-relative path of the document.'),
    status: z.enum(['open', 'resolved', 'all']).default('open')
  }),
  run: async ({ path, status }, { session }) => {
    let loaded
    try {
      loaded = await session.documents.read(path)
    } catch {
      return { ok: false, content: `No document at ${path}.`, summary: `Could not read ${path}` }
    }
    const threads = (await session.reviews.list(loaded.doc.docId)).filter(
      (thread) => status === 'all' || thread.status === status
    )
    if (threads.length === 0) {
      return { ok: true, content: `No ${status === 'all' ? '' : `${status} `}comments on ${path}.`, summary: `Listed comments on ${loaded.doc.title} — none` }
    }
    const content = threads
      .map((thread) => {
        const replies = thread.replies.map((reply) => `    ↳ ${reply.authorId}: ${extractPlainText(reply.body)}`)
        return [
          `${thread.id} · ${thread.authorId} · ${thread.status}${thread.orphaned ? ' · passage no longer found' : ''}`,
          `  on: "${thread.anchorText}"`,
          `  ${extractPlainText(thread.body) || '(no text)'}`,
          ...replies
        ].join('\n')
      })
      .join('\n\n')
    return { ok: true, content, summary: `Listed ${threads.length} comment${threads.length === 1 ? '' : 's'} on ${loaded.doc.title}` }
  }
})

const replyComment = define({
  name: 'reply_comment',
  description: 'Reply to an existing review comment, by its id from list_comments.',
  args: z.object({
    path: z.string().describe('Project-relative path of the document.'),
    threadId: z.string(),
    text: z.string().min(1)
  }),
  run: async ({ path, threadId, text }, context) => {
    let loaded
    try {
      loaded = await context.session.documents.read(path)
    } catch {
      return { ok: false, content: `No document at ${path}.`, summary: `Could not read ${path}` }
    }
    const threads = await context.session.reviews.list(loaded.doc.docId)
    if (!threads.some((thread) => thread.id === threadId)) {
      return { ok: false, content: `There is no comment ${threadId} on ${path}.`, summary: `No comment ${threadId}` }
    }
    await context.session.reviews.reply(loaded.doc.docId, threadId, text, null, { as: context.assistant })
    context.onReviewChanged(loaded.doc.docId)
    return { ok: true, content: 'Replied.', summary: `Replied to a comment on ${loaded.doc.title}` }
  }
})

/*
 * The web tools.
 *
 * Offered only to the extent the writer allowed (see `toolSpecs`), gated
 * again at call time, and never allowed to turn a search result into a
 * citation without the page having been read: `cite_page` wants a capture,
 * and a capture is only ever made by `fetch_page` succeeding. The source it
 * writes is still provisional — a person accepts it — but it arrives with the
 * page's text attached and the access date filled in, which `add_source`'s
 * "attributed, unverified" cards never can.
 */

const webSearchTool = define({
  name: 'web_search',
  description:
    'Search the web. Returns titles, addresses and snippets. Nothing is cited from a search result alone: fetch_page the ones that matter, then cite_page.',
  args: z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(10).default(5)
  }),
  run: async ({ query, limit }, context) => {
    const { web, search } = context
    if (!web.canSearch || !search) {
      return { ok: false, content: 'The author has not allowed web search.', summary: 'Web search not allowed' }
    }
    const result = await search(query, limit)
    if (!result.ok) {
      const why =
        result.reason === 'no-key'
          ? 'No key is saved for the search provider. Tell the author to add one in the AI panel settings.'
          : result.reason === 'no-url'
            ? 'No address is set for the search server. Tell the author to add one in the AI panel settings.'
            : `The search failed (${result.reason}).`
      return { ok: false, content: why, summary: `Web search failed — ${result.reason}` }
    }
    if (result.hits.length === 0) return { ok: true, content: `Nothing found for "${query}".`, summary: `Searched the web for "${query}" — nothing` }
    const content = result.hits.map((hit, index) => `${index + 1}. ${hit.title}\n   ${hit.url}\n   ${hit.snippet}`).join('\n\n')
    return { ok: true, content: taintWith(context, content), summary: `Searched the web for "${query}" — ${result.hits.length} result${result.hits.length === 1 ? '' : 's'}` }
  }
})

const fetchPageTool = define({
  name: 'fetch_page',
  description:
    'Read a web page as text. Only pages the author has allowed: under "pages you name", only addresses they gave you; under "search", any public page. Fetch before you cite.',
  args: z.object({ url: z.string().url() }),
  run: async ({ url }, context) => {
    if (!context.web.allows(url) || !context.fetchPage) {
      return {
        ok: false,
        content:
          context.web.level === 'urls'
            ? 'The author has only allowed pages whose address they gave you. Ask them for the address if you need this one.'
            : 'That address is not one the assistant may fetch.',
        summary: `Refused to fetch ${url}`
      }
    }
    const result = await context.fetchPage(url)
    if (!result.ok) {
      return { ok: false, content: `Could not read ${url} (${result.reason}).`, summary: `Could not fetch ${url}` }
    }
    context.captures.set(url, result.capture)
    const text = result.capture.text
    const clipped = text.length > MAX_PAGE_CHARS ? `${text.slice(0, MAX_PAGE_CHARS)}\n\n[…truncated…]` : text
    return {
      ok: true,
      content: taintWith(context, `# ${result.capture.title}\n${url}\nAccessed ${result.capture.accessed}\n\n${clipped}`),
      summary: `Read ${result.capture.title || url}`
    }
  }
})

const citePageTool = define({
  name: 'cite_page',
  description:
    'Add a web page you have fetched in this conversation to the bibliography as a DRAFT source, with its text attached and the date you read it. The author accepts it. Refused for any page you have not fetched.',
  args: z.object({
    url: z.string().url(),
    claim: z.string().min(1).describe('What the page supports, in a sentence.'),
    title: z.string().default('').describe('Override the page title if it is better stated.'),
    author: z.string().default(''),
    year: z.string().default('')
  }),
  run: async ({ url, claim, title, author, year }, context) => {
    const capture = context.captures.get(url)
    if (!capture) {
      return {
        ok: false,
        content: 'You have not fetched that page in this conversation. Call fetch_page first; a citation is only written for a page you have read.',
        summary: `Refused to cite an unread page`
      }
    }
    const issued = Number(year)
    try {
      const source = await context.session.sources.addProvisional({
        id: ulid(),
        type: 'webpage',
        title: title || capture.title || url,
        ...(author ? { author: [{ literal: author }] } : {}),
        ...(Number.isFinite(issued) && year ? { issued: { 'date-parts': [[issued]] } } : {}),
        ...applyCaptureToCslFields(url, capture.accessed),
        note: `Captured by the assistant: ${claim}`
      })
      await context.session.sources.addCaptureAttachment(source.id, capture, url)
      return {
        ok: true,
        content: `Added "${source.title}" to the bibliography as a draft, with the page's text attached. Tell the author it is there to check.`,
        summary: `Cited "${source.title}" (captured)`
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, content: message, summary: 'Could not add the source' }
    }
  }
})

const proofread = define({
  name: 'proofread',
  description:
    'Proofread a document for spelling, grammar and punctuation (and, if asked, style), suggesting every correction as a tracked change the author accepts or rejects. Works through the whole document in passes; a long document reports where it stopped so you can call again with fromBlock.',
  args: z.object({
    path: z.string().describe('Project-relative path of the document.'),
    kinds: z
      .array(z.enum(PROOFREAD_KINDS))
      .default((): ProofreadKind[] => ['spelling', 'grammar', 'punctuation'])
      .describe('Which problems to look for. Add "style" only when the author asked for it.'),
    fromBlock: z.number().int().min(0).default(0).describe('First paragraph to check; use what a previous call reported.'),
    toBlock: z.number().int().min(0).optional().describe('Last paragraph to check, inclusive.')
  }),
  run: async ({ path, kinds, fromBlock, toBlock }, context) => {
    let loaded
    try {
      loaded = await context.session.documents.read(path)
    } catch {
      return { ok: false, content: `No document at ${path}.`, summary: `Could not read ${path}` }
    }
    const blocks = extractBlocks(loaded.doc.content).filter(
      (block) => block.index >= fromBlock && (toBlock === undefined || block.index <= toBlock)
    )
    const chunks = chunkBlocks(blocks)
    const covered = chunks.slice(0, MAX_PROOFREAD_CALLS)
    const lang = loaded.doc.lang ?? context.session.manifest.publication.language ?? ''

    const placed: PlacedFinding[] = []
    let dropped = 0
    let checked = 0
    for (const chunk of covered) {
      const prompt = proofreadPrompt(chunk, kinds, lang)
      let reply: string
      try {
        reply = await context.complete(prompt.system, prompt.user, 2_048)
      } catch (error) {
        // Stopped partway — a budget, a dropped connection — the passes that
        // finished are still worth delivering, with where to resume.
        if (checked === 0) throw error
        break
      }
      const parsed = parseFindings(reply, chunk)
      placed.push(...parsed.placed)
      dropped += parsed.dropped
      checked += 1
    }
    covered.splice(checked)

    // One edit per mode for the whole pass: one undo step in the editor, one
    // write to a closed file, one row in the trail — not one of each per typo.
    // Under `direct-trivial`, spelling and punctuation are the trivial kinds.
    const landed = emitByMode(
      context,
      loaded.doc.docId,
      path,
      placed.map((finding) => ({
        op: finding.op,
        trivial: (finding.kind === 'spelling' || finding.kind === 'punctuation') && isTrivial(
          blocks.find((block) => block.index === finding.op.blockIndex)?.text.slice(finding.op.start, finding.op.end) ?? '',
          finding.op.text
        )
      }))
    )

    const lastChecked = covered.at(-1)?.at(-1)?.index
    const remaining = chunks.length > covered.length ? chunks[covered.length]![0]!.index : null
    const described = describeFindings(placed)
    const notes = [
      placed.length > 0
        ? landed.suggested === 0
          ? `Applied ${described} directly, each marked as yours. Do not repeat them in your reply.`
          : landed.direct === 0
            ? `Suggested ${described} as tracked changes; the author will accept or reject each. Do not repeat them in your reply.`
            : `Applied ${landed.direct} trivial correction${landed.direct === 1 ? '' : 's'} directly and suggested ${landed.suggested} as tracked changes (${described} in all). Do not repeat them in your reply.`
        : `Found nothing to correct${lastChecked !== undefined ? ` in paragraphs ${fromBlock}–${lastChecked}` : ''}.`,
      dropped > 0 ? `${dropped} finding${dropped === 1 ? '' : 's'} could not be placed and were dropped.` : '',
      remaining !== null
        ? `Stopped after paragraph ${lastChecked}; call proofread again with fromBlock=${remaining} to continue.`
        : ''
    ].filter(Boolean)
    return {
      ok: true,
      content: notes.join(' '),
      summary: `Proofread ${loaded.doc.title} — ${described}${remaining !== null ? ` (through paragraph ${lastChecked})` : ''}`
    }
  }
})

/*
 * The writing tools.
 *
 * Every one of them proposes. For prose that means a suggestion mark; for
 * records and sources it means a *draft* — a real record, flagged
 * `provisional`, that a person accepts, edits or discards. There is no path
 * here by which a model's output becomes project truth without a human action,
 * and the refusals that guarantee it live in the services (`EntityService.revise`,
 * `SourceService.addProvisional`) rather than in these descriptions, because a
 * description is a request and a service is an answer.
 */

const draftRecord = define({
  name: 'draft_record',
  description:
    'Draft one story record — a character, a location, or any other kind this project defines. The record is created as a DRAFT the author accepts or discards; it is not yet part of their project. Use list_records first to see what kinds exist and to avoid drafting someone they already have.',
  args: z.object({
    kind: z.string().describe('The kind id, e.g. "character". Must be one this project defines.'),
    name: z.string().describe('The name of the person or place.'),
    summary: z.string().default('').describe('One or two lines to remember them by.'),
    fields: z
      .array(z.object({ label: z.string(), value: z.string() }))
      .default(() => [])
      .describe('Details, e.g. {"label":"Occupation","value":"Dockworker"}.')
  }),
  run: async ({ kind, name, summary, fields }, { session }) => {
    const entity = await session.entities.draft(kind, name, { summary, fields })
    return {
      ok: true,
      content: `Drafted ${entity.name} as a ${kind}. The author will accept or discard it. Do not draft them again.`,
      summary: `Drafted ${entity.name} (${kind})`
    }
  }
})

const draftEnsemble = define({
  name: 'draft_ensemble',
  description:
    'Draft a whole group of records at once against constraints the group must satisfy together — a ship\'s crew of eight, mixed nationalities, exactly one lying about why they signed on. Generate every member in this one call: a group produced one member at a time cannot satisfy a group constraint except by accident. For each constrained property, every record must report its value in `properties`, using the property name exactly as it appears in the constraint — "yes" or "no" for exactlyOne and atLeast properties. The constraints are checked here, and a group that fails them is handed back to you to redraft.',
  args: z.object({
    kind: z.string().describe('The kind id every member of the group is, e.g. "character".'),
    premise: z.string().default('').describe('What this group is, in a sentence.'),
    constraints: z
      .object({
        distinct: z.array(z.string()).default(() => []).describe('Properties no two members may share.'),
        exactlyOne: z.array(z.string()).default(() => []).describe('Properties exactly one member has.'),
        atLeast: z
          .array(z.object({ count: z.number().int().min(1), property: z.string() }))
          .default(() => [])
          .describe('Properties at least `count` members have.')
      })
      .default(() => ({ distinct: [], exactlyOne: [], atLeast: [] })),
    records: z
      .array(
        z.object({
          name: z.string(),
          summary: z.string().default(''),
          fields: z.array(z.object({ label: z.string(), value: z.string() })).default(() => []),
          properties: z
            .record(z.string(), z.string())
            .default(() => ({}))
            .describe('This member\'s value for each constrained property.')
        })
      )
      .min(1)
      .describe('Every member of the group.')
  }),
  run: async ({ kind, premise, constraints, records }, { session, ensembleAttempts }) => {
    const parsedConstraints = ensembleConstraintsSchema.parse(constraints)
    const drafted = records.map((record) => draftedRecordSchema.parse(record))
    const failures = validateEnsemble(drafted, parsedConstraints)

    /*
     * One redraft, then the group is written with what it failed said out loud.
     * Retrying forever spends the step budget on a constraint the model may
     * simply be unable to meet; shipping a group that violates the constraint
     * the writer typed, silently, is worse than either.
     */
    const key = `${kind}:${premise}`
    const attempts = (ensembleAttempts.get(key) ?? 0) + 1
    ensembleAttempts.set(key, attempts)

    if (failures.length > 0 && attempts < 2) {
      return {
        ok: false,
        content: `That group does not meet its constraints, so nothing was drafted. ${describeFailures(
          failures
        )} Draft the whole group again, in one call, fixing these.`,
        summary: `Ensemble of ${drafted.length} failed its constraints`
      }
    }

    for (const record of drafted) {
      // The constraint ledger becomes ordinary detail fields: what the model
      // committed to should be readable on the card the writer is judging.
      const properties = Object.entries(record.properties).map(([label, value]) => ({ label, value }))
      await session.entities.draft(kind, record.name, {
        summary: record.summary,
        fields: [...record.fields, ...properties]
      })
    }

    const unmet =
      failures.length > 0
        ? ` It does not meet every constraint, and the author has been told which: ${describeFailures(failures)}`
        : ''
    return {
      ok: true,
      content: `Drafted ${drafted.length} ${kind} records for the author to accept or discard.${unmet}`,
      summary:
        failures.length > 0
          ? `Drafted ${drafted.length} ${kind}s — unmet: ${describeFailures(failures)}`
          : `Drafted ${drafted.length} ${kind}s`
    }
  }
})

const reviseRecord = define({
  name: 'revise_record',
  description:
    'Change a record you drafted and the author has not yet accepted. Records the author has accepted cannot be changed — propose the change to them in your reply instead.',
  args: z.object({
    name: z.string().describe('The name of the drafted record to change.'),
    summary: z.string().default('').describe('Replaces the summary, when given.'),
    fields: z
      .array(z.object({ label: z.string(), value: z.string() }))
      .default(() => [])
      .describe('Replaces the details, when given.')
  }),
  run: async ({ name, summary, fields }, { session }) => {
    const wanted = name.trim().toLowerCase()
    const entity = session.entities
      .snapshot()
      .entities.find((candidate) => candidate.name.toLowerCase() === wanted)
    if (!entity) return { ok: false, content: `No record called "${name}".`, summary: `No record "${name}"` }

    try {
      const revised = await session.entities.revise(entity.id, {
        ...(summary ? { summary } : {}),
        ...(fields.length > 0 ? { fields } : {})
      })
      return { ok: true, content: `Revised ${revised.name}.`, summary: `Revised ${revised.name}` }
    } catch (error) {
      // The refusal reaches the model as an ordinary failed result: it is
      // something to tell the author about, not something to work around.
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, content: message, summary: `Refused to revise ${entity.name}` }
    }
  }
})

const addSource = define({
  name: 'add_source',
  description:
    'Record a claim and the work you are attributing it to, as a DRAFT source in the project\'s bibliography. You cannot browse, so this is your own attribution and it is stored as unverified for the author to check. Never invent a citation to satisfy a request: if you do not know a real work that supports the claim, say so in your reply instead of calling this.',
  args: z.object({
    claim: z.string().describe('What the source is being cited for, in a sentence.'),
    type: z.string().default('webpage').describe('CSL type: book, article-journal, webpage, report…'),
    title: z.string().describe('Title of the work.'),
    author: z.string().default('').describe('Author surname(s), or an organisation.'),
    year: z.string().default('').describe('Year of publication.'),
    containerTitle: z.string().default('').describe('Journal, newspaper or book the work is in.'),
    publisher: z.string().default(''),
    url: z.string().default(''),
    doi: z.string().default('')
  }),
  run: async (args, { session }) => {
    const year = Number(args.year)
    try {
      const source = await session.sources.addProvisional({
        id: ulid(),
        type: args.type,
        title: args.title,
        ...(args.author ? { author: [{ literal: args.author }] } : {}),
        ...(Number.isFinite(year) && args.year ? { issued: { 'date-parts': [[year]] } } : {}),
        ...(args.containerTitle ? { 'container-title': args.containerTitle } : {}),
        ...(args.publisher ? { publisher: args.publisher } : {}),
        ...(args.url ? { URL: args.url } : {}),
        ...(args.doi ? { DOI: args.doi } : {}),
        // What the claim was is the only thing that makes the citation
        // checkable later; a reference with no claim beside it is unfalsifiable.
        note: `Attributed by the assistant, not verified: ${args.claim}`
      })
      return {
        ok: true,
        content: `Added "${source.title}" as an unverified source. Tell the author it is your attribution and that they should check it.`,
        summary: `Added the source "${source.title}" (unverified)`
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, content: message, summary: 'Refused an uncheckable source' }
    }
  }
})

/**
 * Tools that write something a person then has to look at.
 *
 * Named here so the panels showing what they wrote can be told to reload —
 * a drafted cast that does not appear until the project is reopened is a
 * drafted cast the writer will assume failed.
 */
export const RECORD_WRITING_TOOLS = ['draft_record', 'draft_ensemble', 'revise_record']
export const SOURCE_WRITING_TOOLS = ['add_source', 'cite_page']
export const WEB_TOOLS = ['web_search', 'fetch_page', 'cite_page']
export const REVIEW_WRITING_TOOLS = ['comment', 'reply_comment']

const TOOLS = [
  searchManuscript,
  findPassages,
  readDocument,
  listDocuments,
  listRecords,
  readRecord,
  listBeats,
  readOutline,
  suggestEdit,
  comment,
  listComments,
  replyComment,
  proofread,
  webSearchTool,
  fetchPageTool,
  citePageTool,
  draftRecord,
  draftEnsemble,
  reviseRecord,
  addSource
]

/**
 * The tools, described in the shape both dialects are serialised from.
 *
 * Generated from the same zod schemas the handlers validate with, so a tool
 * cannot be described to the model in a shape its handler would reject.
 *
 * A project with no retrieval index is not offered `find_passages` at all,
 * rather than being offered one that always refuses: a described tool is one
 * the model will spend a step calling.
 */
export function toolSpecs(
  options: { retrieval: boolean; web?: WebGate['level'] } = { retrieval: false }
): ToolSpec[] {
  const web = options.web ?? 'none'
  return TOOLS.filter((tool) => {
    if (tool.name === 'find_passages') return options.retrieval
    // Not offered rather than offered-and-refused, as with `find_passages`:
    // a described tool is one the model will spend a step calling.
    if (tool.name === 'web_search') return web === 'search'
    if (tool.name === 'fetch_page' || tool.name === 'cite_page') return web !== 'none'
    return true
  }).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: z.toJSONSchema(tool.args, { target: 'draft-7' }) as Record<string, unknown>
  }))
}

/**
 * Run one call.
 *
 * A tool that throws, is unknown, or is handed arguments that do not validate
 * comes back as an ordinary failed result rather than an exception: the model
 * can read the message and try again, which is a better outcome than ending
 * the run.
 */
export async function runTool(
  name: string,
  rawArgs: string,
  context: ToolContext
): Promise<ToolResult> {
  const tool = TOOLS.find((candidate) => candidate.name === name)
  if (!tool) {
    return { ok: false, content: `There is no tool called ${name}.`, summary: `Unknown tool ${name}` }
  }

  let parsed: unknown
  try {
    parsed = rawArgs.trim() ? JSON.parse(rawArgs) : {}
  } catch {
    return { ok: false, content: 'Those arguments were not valid JSON.', summary: `${name}: bad arguments` }
  }

  const args = tool.args.safeParse(parsed)
  if (!args.success) {
    return {
      ok: false,
      content: `Those arguments are not right: ${args.error.issues.map((issue) => issue.message).join('; ')}`,
      summary: `${name}: bad arguments`
    }
  }

  try {
    return await tool.run(args.data, context)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, content: `That failed: ${message}`, summary: `${name} failed` }
  }
}
