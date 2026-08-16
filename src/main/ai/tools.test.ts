import { describe, it, expect } from 'vitest'
import { toolSpecs, runTool, type RetrievalResult } from './tools.js'
import type { ProjectSession } from '../services/projectSession.js'

const session = {} as ProjectSession

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
    const result = await runTool('find_passages', JSON.stringify({ query: 'the sea' }), {
      session,
      onProposal: () => {},
      findPassages: async () => retrieval()
    })

    expect(result.ok).toBe(true)
    expect(result.content).toContain('chapter-01.pubdoc (block 3)')
    expect(result.content).toContain('The harbour lay under a low sky.')
    expect(result.summary).toContain('1 passage')
  })

  it('says how much of the project was actually searched when the index is partial', async () => {
    // Without this the model answers "you never mention it" from a third of the
    // book — confidently wrong, and nothing downstream can catch it.
    const result = await runTool('find_passages', JSON.stringify({ query: 'grief' }), {
      session,
      onProposal: () => {},
      findPassages: async () => retrieval({ embedded: 30, total: 90 })
    })

    expect(result.content).toContain('30 of 90')
  })

  it('says nothing about coverage when the index is complete', async () => {
    const result = await runTool('find_passages', JSON.stringify({ query: 'grief' }), {
      session,
      onProposal: () => {},
      findPassages: async () => retrieval({ hits: [] })
    })

    expect(result.content).not.toContain('indexed for meaning')
  })

  it('points at the keyword search when there is no index at all', async () => {
    const result = await runTool('find_passages', JSON.stringify({ query: 'grief' }), {
      session,
      onProposal: () => {}
    })

    expect(result.ok).toBe(false)
    expect(result.content).toContain('search_manuscript')
  })
})
