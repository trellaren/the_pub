import { describe, it, expect } from 'vitest'
import { describeProject, BRIEF_MAX_CHARS, type ProjectFacts } from './projectContext.js'

const facts: ProjectFacts = {
  name: 'The Harbour',
  projectType: 'novel',
  documents: ['One', 'Two'],
  records: [
    { kind: 'character', kindLabel: 'Characters', name: 'Aurelio' },
    { kind: 'character', kindLabel: 'Characters', name: 'Benedita' },
    { kind: 'location', kindLabel: 'Locations', name: 'Lisbon' }
  ],
  outlineBeats: [{ title: 'The storm', summary: 'The boat does not come back.' }],
  openComments: 2
}

describe('describeProject', () => {
  it('names the project, its documents, its people and places, and what is still to write', () => {
    const brief = describeProject(facts)
    expect(brief).toContain('"The Harbour", a novel')
    expect(brief).toContain('Manuscript (2 documents): One; Two.')
    expect(brief).toContain('characters: Aurelio, Benedita; locations: Lisbon')
    expect(brief).toContain('The storm (The boat does not come back.)')
    expect(brief).toContain('2 open review comments')
  })

  it('says nothing about what the project does not have', () => {
    const brief = describeProject({ ...facts, documents: [], records: [], outlineBeats: [], openComments: null })
    expect(brief).toBe('The project is "The Harbour", a novel.')
  })

  it('caps the names and the length, and says how many were left out', () => {
    const many = Array.from({ length: 80 }, (_, index) => ({ kind: 'character', kindLabel: 'Characters', name: `Person ${index}` }))
    const titles = Array.from({ length: 30 }, (_, index) => `Chapter ${index}`)
    const brief = describeProject({ ...facts, records: many, documents: titles })
    expect(brief).toContain('and 30 more')
    expect(brief).toContain('and 18 more')
    expect(brief.length).toBeLessThanOrEqual(BRIEF_MAX_CHARS)
  })

  it('writes the project type as words', () => {
    expect(describeProject({ ...facts, projectType: 'research-paper' })).toContain('a research paper')
  })
})
