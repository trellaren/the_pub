import { z } from 'zod'
import { ulid } from 'ulid'
import type { ProjectSession } from '../services/projectSession.js'
import type { EditProposal } from '../../shared/model/ai.js'
import type { SemanticHit } from '../services/searchIndexService.js'
import { extractPlainText } from '../../shared/pm/extractText.js'
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
 * `proposeEdit` returns a proposal for the author to accept or dismiss, and
 * that is the entire extent of the agent's reach into prose. Accept/reject,
 * attribution and undo are worth inheriting rather than rebuilding, and until
 * Phase 9's suggestion marks exist a proposal is reviewed in the panel; when
 * they do, this is the one place that changes.
 */

const MAX_SEARCH_HITS = 12
const MAX_DOCUMENT_CHARS = 12_000

/** What a semantic search came back with, and how much of the book it covered. */
export interface RetrievalResult {
  hits: SemanticHit[]
  embedded: number
  total: number
}

export interface ToolContext {
  session: ProjectSession
  /** Collects proposals as they are made, so the loop can stream them out. */
  onProposal: (proposal: EditProposal) => void
  /**
   * How many times each ensemble has been attempted in this run, so a group
   * that fails its constraints is redrafted once and then written with the
   * failures named rather than retried until the step budget runs out. Lives on
   * the run, not the call: two calls are the whole point of counting.
   */
  ensembleAttempts: Map<string, number>
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

const proposeEdit = define({
  name: 'propose_edit',
  description:
    'Propose a change to a document. This does NOT change the document — it shows the author a suggestion they can accept or dismiss. Quote the existing text exactly in `find`.',
  args: z.object({
    path: z.string().describe('Project-relative path of the document to change.'),
    find: z.string().describe('The exact existing text to replace.'),
    replace: z.string().describe('What to put in its place.'),
    reason: z.string().default('').describe('Why, in one sentence.')
  }),
  run: async ({ path, find, replace, reason }, { session, onProposal }) => {
    // Verified against the document before it is offered: a proposal quoting
    // text that is not there cannot be applied, and finding that out when the
    // author clicks accept is finding out too late.
    try {
      const loaded = await session.documents.read(path)
      const text = extractPlainText(loaded.doc.content)
      if (find && !text.includes(find)) {
        return {
          ok: false,
          content: `That exact text is not in ${path}. Quote it exactly as it appears.`,
          summary: `Proposed an edit to ${path} that did not match`
        }
      }
    } catch {
      return { ok: false, content: `No document at ${path}.`, summary: `Could not read ${path}` }
    }

    onProposal({ id: ulid(), docPath: path, find, replace, reason })
    return {
      ok: true,
      content: 'The proposal was shown to the author, who will accept or dismiss it. Do not repeat it.',
      summary: `Proposed an edit to ${path}`
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
export const SOURCE_WRITING_TOOLS = ['add_source']

const TOOLS = [
  searchManuscript,
  findPassages,
  readDocument,
  listDocuments,
  listRecords,
  readRecord,
  proposeEdit,
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
export function toolSpecs(options: { retrieval: boolean } = { retrieval: false }): ToolSpec[] {
  return TOOLS.filter((tool) => options.retrieval || tool.name !== 'find_passages').map((tool) => ({
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
