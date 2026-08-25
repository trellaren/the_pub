import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { toolSpecs, runTool, type RetrievalResult, type ToolContext } from './tools.js'
import { EntityService } from '../services/entityService.js'
import { SourceService } from '../services/sourceService.js'
import { LocalAdapter } from '../vfs/localAdapter.js'
import { isProvisional } from '../../shared/model/source.js'
import type { ProjectSession } from '../services/projectSession.js'

let root: string
let adapter: LocalAdapter
let entities: EntityService
let sources: SourceService

/**
 * The real services, on a temp directory.
 *
 * The refusals this phase turns on — a revision to an accepted record, a
 * citation with nothing to check — live in the services, deliberately. A fake
 * session here would be testing the fake.
 */
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-tools-'))
  adapter = new LocalAdapter(root)
  entities = new EntityService(adapter)
  sources = new SourceService(adapter)
  await entities.load()
  await sources.load()
})

afterEach(async () => {
  await adapter.dispose()
  await fs.rm(root, { recursive: true, force: true })
})

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    session: { entities, sources } as unknown as ProjectSession,
    onProposal: () => {},
    ensembleAttempts: new Map(),
    ...overrides
  }
}

function retrieval(partial: Partial<RetrievalResult> = {}): RetrievalResult {
  return {
    hits: [
      {
        docId: 'doc-1',
        path: 'chapter-01.pubdoc',
        title: 'One',
        blockIndex: 3,
        text: 'The harbour lay under a low sky.',
        score: 0.82
      }
    ],
    embedded: 10,
    total: 10,
    ...partial
  }
}

describe('toolSpecs', () => {
  it('offers find_passages only where there is an index to search', () => {
    // A described tool is one the model will spend a step calling, so a tool
    // that can only refuse is worse than no tool.
    expect(toolSpecs({ retrieval: false }).map((spec) => spec.name)).not.toContain('find_passages')
    expect(toolSpecs({ retrieval: true }).map((spec) => spec.name)).toContain('find_passages')
  })

  it('describes arguments from the same schema the handler validates', () => {
    const spec = toolSpecs({ retrieval: true }).find((candidate) => candidate.name === 'find_passages')!
    expect(spec.parameters).toMatchObject({ properties: { query: { type: 'string' } } })
  })
})

describe('find_passages', () => {
  it('returns the passages with the document and block each came from', async () => {
    const result = await runTool(
      'find_passages',
      JSON.stringify({ query: 'the sea' }),
      context({ findPassages: async () => retrieval() })
    )

    expect(result.ok).toBe(true)
    expect(result.content).toContain('chapter-01.pubdoc (block 3)')
    expect(result.content).toContain('The harbour lay under a low sky.')
    expect(result.summary).toContain('1 passage')
  })

  it('says how much of the project was actually searched when the index is partial', async () => {
    // Without this the model answers "you never mention it" from a third of the
    // book — confidently wrong, and nothing downstream can catch it.
    const result = await runTool(
      'find_passages',
      JSON.stringify({ query: 'grief' }),
      context({ findPassages: async () => retrieval({ embedded: 30, total: 90 }) })
    )

    expect(result.content).toContain('30 of 90')
  })

  it('says nothing about coverage when the index is complete', async () => {
    const result = await runTool(
      'find_passages',
      JSON.stringify({ query: 'grief' }),
      context({ findPassages: async () => retrieval({ hits: [] }) })
    )

    expect(result.content).not.toContain('indexed for meaning')
  })

  it('points at the keyword search when there is no index at all', async () => {
    const result = await runTool('find_passages', JSON.stringify({ query: 'grief' }), context())

    expect(result.ok).toBe(false)
    expect(result.content).toContain('search_manuscript')
  })
})

describe('draft_record', () => {
  it('writes a real record, flagged as the model\'s guess', async () => {
    const result = await runTool(
      'draft_record',
      JSON.stringify({ kind: 'character', name: 'Aurelio', summary: 'A dockworker.' }),
      context()
    )

    expect(result.ok).toBe(true)
    const [drafted] = entities.snapshot().entities
    // Real, in the file, with an id — not a preview in a sidecar. A draft the
    // writer cannot search, mention or link to a beat is one they cannot judge.
    expect(drafted!.name).toBe('Aurelio')
    expect(drafted!.summary).toBe('A dockworker.')
    expect(drafted!.provisional).toBe(true)
  })
})

describe('draft_ensemble', () => {
  const crew = (records: unknown[], constraints: unknown) =>
    JSON.stringify({ kind: 'character', premise: "a ship's crew", constraints, records })

  const sailor = (name: string, properties: Record<string, string>) => ({
    name,
    summary: '',
    fields: [],
    properties
  })

  it('writes the whole group when it meets its constraints', async () => {
    const result = await runTool(
      'draft_ensemble',
      crew(
        [sailor('Aurelio', { lying: 'yes' }), sailor('Benedita', { lying: 'no' })],
        { exactlyOne: ['lying'] }
      ),
      context()
    )

    expect(result.ok).toBe(true)
    expect(entities.snapshot().entities.map((entity) => entity.name)).toEqual(['Aurelio', 'Benedita'])
    expect(entities.snapshot().entities.every((entity) => entity.provisional)).toBe(true)
    // The ledger the group was judged on becomes readable detail on the card.
    expect(entities.snapshot().entities[0]!.fields).toContainEqual({ label: 'lying', value: 'yes' })
  })

  it('writes nothing and names the failures on the first bad group', async () => {
    const result = await runTool(
      'draft_ensemble',
      crew(
        [sailor('Aurelio', { lying: 'yes' }), sailor('Benedita', { lying: 'yes' })],
        { exactlyOne: ['lying'] }
      ),
      context()
    )

    expect(result.ok).toBe(false)
    expect(result.content).toContain('exactly one')
    expect(entities.snapshot().entities).toEqual([])
  })

  it('takes the second attempt with its shortfall said out loud', async () => {
    /*
     * Retrying forever spends the step budget on a constraint the model may
     * be unable to meet; shipping a group that violates the writer's own
     * constraint silently is worse than either. So: one redraft, then write it
     * with what it failed on the record.
     */
    const shared = context()
    const bad = crew(
      [sailor('Aurelio', { lying: 'yes' }), sailor('Benedita', { lying: 'yes' })],
      { exactlyOne: ['lying'] }
    )
    await runTool('draft_ensemble', bad, shared)
    const second = await runTool('draft_ensemble', bad, shared)

    expect(second.ok).toBe(true)
    expect(second.summary).toContain('unmet')
    expect(entities.snapshot().entities).toHaveLength(2)
  })
})

describe('revise_record', () => {
  it('changes a record it drafted', async () => {
    await entities.draft('character', 'Aurelio', { summary: 'A dockworker.' })
    const result = await runTool(
      'revise_record',
      JSON.stringify({ name: 'Aurelio', summary: 'A dockworker with a debt.' }),
      context()
    )

    expect(result.ok).toBe(true)
    expect(entities.snapshot().entities[0]!.summary).toBe('A dockworker with a debt.')
  })

  it('refuses a record the writer has accepted', async () => {
    /*
     * The failure this whole design exists to prevent: a model helpfully
     * tidying a character the writer spent an afternoon on. The service says
     * no — the tool description asking nicely is not the mechanism.
     */
    const accepted = await entities.draft('character', 'Aurelio', { summary: 'A dockworker.' })
    await entities.accept(accepted.id)

    const result = await runTool(
      'revise_record',
      JSON.stringify({ name: 'Aurelio', summary: 'Something else entirely.' }),
      context()
    )

    expect(result.ok).toBe(false)
    expect(result.content).toContain('accepted')
    expect(entities.snapshot().entities[0]!.summary).toBe('A dockworker.')
  })

  it('says so rather than inventing a record that is not there', async () => {
    const result = await runTool('revise_record', JSON.stringify({ name: 'Nobody' }), context())
    expect(result.ok).toBe(false)
    expect(entities.snapshot().entities).toEqual([])
  })
})

describe('add_source', () => {
  it('stores an attributed citation as unverified, with the claim beside it', async () => {
    const result = await runTool(
      'add_source',
      JSON.stringify({
        claim: 'A Lisbon dockworker earned about 30 escudos a day in 1954.',
        type: 'book',
        title: 'Labour in the Estado Novo',
        author: 'Rosas',
        year: '1994'
      }),
      context()
    )

    expect(result.ok).toBe(true)
    const [source] = sources.snapshot().sources
    expect(isProvisional(source!)).toBe(true)
    // The claim is what makes the citation checkable later; a reference with no
    // claim beside it cannot be falsified.
    expect(String(source!.note)).toContain('not verified')
    expect(String(source!.note)).toContain('30 escudos')
  })

  it('refuses a citation nobody could go and check', async () => {
    // A confident fabricated citation in a thesis bibliography is career
    // damage, so an entry with no work and no URL is refused, not stored.
    const result = await runTool(
      'add_source',
      JSON.stringify({ claim: 'Something was true once.', title: 'Untraceable' }),
      context()
    )

    expect(result.ok).toBe(false)
    expect(sources.snapshot().sources).toEqual([])
  })
})
