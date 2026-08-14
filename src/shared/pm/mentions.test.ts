import { describe, it, expect } from 'vitest'
import {
  buildScanForms,
  compileForm,
  scanBlockText,
  extractMentionMarks,
  extractDocumentMentions,
  findOccurrence,
  dismissKey
} from './mentions.js'
import { storyEntitySchema, type StoryEntity } from '../model/entity.js'
import { extractRawBlocks } from './extractText.js'
import type { PmDoc } from '../model/document.js'

function entity(patch: Partial<StoryEntity> & { id: string; name: string }): StoryEntity {
  return storyEntitySchema.parse({
    kind: 'character',
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    ...patch
  })
}

const harlan = entity({ id: 'e1', name: 'Harlan' })

function formsFor(...entities: StoryEntity[]) {
  return buildScanForms(entities)
}

function scan(text: string, entities: StoryEntity[] = [harlan], confirmed: { start: number; end: number }[] = []) {
  return scanBlockText(text, formsFor(...entities), confirmed)
}

describe('word boundaries', () => {
  it('matches a name standing alone', () => {
    expect(scan('Harlan went north')).toEqual([
      { entityId: 'e1', surface: 'Harlan', start: 0, end: 6 }
    ])
  })

  it('does not match inside a longer word', () => {
    expect(scan('Harlanders everywhere')).toEqual([])
    expect(scan('theHarlan')).toEqual([])
  })

  it('matches against punctuation on either side', () => {
    expect(scan('"Harlan," she said.')).toHaveLength(1)
  })
})

describe('possessives', () => {
  it('matches but stops the range before the apostrophe', () => {
    const [hit] = scan("Harlan's brother")
    // The mark must cover the name only, leaving 's as plain text.
    expect(hit).toMatchObject({ start: 0, end: 6, surface: 'Harlan' })
  })

  it('handles a curly apostrophe the same way', () => {
    const [hit] = scan('Harlan’s brother')
    expect(hit).toMatchObject({ start: 0, end: 6 })
  })

  it('does not match a plural', () => {
    expect(scan('the Harlans of this world')).toEqual([])
  })
})

describe('the capitalisation rule', () => {
  it('matches a capitalised name case-sensitively', () => {
    const rose = entity({ id: 'e2', name: 'Rose' })
    expect(scan('Rose crossed the yard', [rose])).toHaveLength(1)
    // The single most valuable rule: the flower is not the character.
    expect(scan('he picked a rose', [rose])).toEqual([])
  })

  it('matches an uncapitalised form case-insensitively', () => {
    const nickname = entity({ id: 'e3', name: 'the kid' })
    expect(scan('The Kid rode in', [nickname])).toHaveLength(1)
  })
})

describe('minimum length', () => {
  it('ignores forms shorter than three characters', () => {
    expect(compileForm('e1', 'Al')).toBeNull()
    const al = entity({ id: 'e4', name: 'Al' })
    // Short names stay reachable through an explicit @-mention.
    expect(formsFor(al)).toEqual([])
  })
})

describe('multi-word forms', () => {
  it('matches across any run of whitespace', () => {
    const ridge = entity({ id: 'e5', kind: 'location', name: 'Blue Ridge' })
    expect(scan('over Blue  Ridge tonight', [ridge])).toHaveLength(1)
  })

  it('lets the longest form win when two overlap', () => {
    const blue = entity({ id: 'e6', kind: 'location', name: 'Blue' })
    const ridge = entity({ id: 'e7', kind: 'location', name: 'Blue Ridge' })
    const hits = scan('over Blue Ridge tonight', [blue, ridge])
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ entityId: 'e7', surface: 'Blue Ridge' })
  })
})

describe('aliases and scan flags', () => {
  it('scans aliases as well as the name', () => {
    const withAlias = entity({ id: 'e1', name: 'Harlan', aliases: [{ text: 'the Sheriff', scan: true }] })
    expect(scan('the Sheriff rode in', [withAlias])).toHaveLength(1)
  })

  it('respects a per-alias scan flag', () => {
    const withAlias = entity({ id: 'e1', name: 'Harlan', aliases: [{ text: 'Boss', scan: false }] })
    expect(scan('Boss said no', [withAlias])).toEqual([])
  })

  it('respects the whole-record scan flag', () => {
    const quiet = entity({ id: 'e1', name: 'Harlan', scan: false })
    expect(formsFor(quiet)).toEqual([])
  })
})

describe('confirmed suppression', () => {
  it('drops a suggestion that overlaps a confirmed range', () => {
    expect(scan('Harlan went north', [harlan], [{ start: 0, end: 6 }])).toEqual([])
  })

  it('still suggests a second occurrence in the same block', () => {
    // Per occurrence, not per block: confirming one mention must not hide the
    // rest of the paragraph.
    const hits = scan("Harlan told Harlan's brother", [harlan], [{ start: 0, end: 6 }])
    expect(hits).toHaveLength(1)
    expect(hits[0]!.start).toBe(12)
  })
})

describe('findOccurrence', () => {
  it('locates the n-th literal occurrence', () => {
    const text = "Harlan told Harlan's brother"
    expect(findOccurrence(text, 'Harlan', 0)).toBe(0)
    expect(findOccurrence(text, 'Harlan', 1)).toBe(12)
    expect(findOccurrence(text, 'Harlan', 2)).toBe(-1)
  })

  it('returns -1 for an empty surface', () => {
    expect(findOccurrence('anything', '', 0)).toBe(-1)
  })
})

describe('extractMentionMarks', () => {
  const marked = (entityId: string) => [{ type: 'mention', attrs: { entityId } }]

  it('joins a name split by a bold run into one mention', () => {
    const doc: PmDoc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', marks: marked('e1'), text: 'Har' },
            { type: 'text', marks: [...marked('e1'), { type: 'bold' }], text: 'lan' },
            { type: 'text', text: ' went north' }
          ]
        }
      ]
    }
    const block = extractRawBlocks(doc)[0]!
    expect(extractMentionMarks(block.node, block.text)).toEqual([
      { entityId: 'e1', blockIndex: 0, start: 0, end: 6, ordinal: 0, surface: 'Harlan', confirmed: true }
    ])
  })

  it('reports offsets in normalised coordinates', () => {
    const doc: PmDoc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '  ' },
            { type: 'text', marks: marked('e1'), text: 'Harlan' },
            { type: 'hardBreak' },
            { type: 'text', text: 'went north' }
          ]
        }
      ]
    }
    const block = extractRawBlocks(doc)[0]!
    // Two spaces are trimmed away, so the mention starts at 0, not at 2.
    expect(extractMentionMarks(block.node, block.text)[0]).toMatchObject({ start: 0, end: 6 })
  })

  it('numbers repeated surfaces by ordinal', () => {
    const doc: PmDoc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Harlan told ' },
            { type: 'text', marks: marked('e1'), text: 'Harlan' },
            { type: 'text', text: ' nothing' }
          ]
        }
      ]
    }
    const block = extractRawBlocks(doc)[0]!
    expect(extractMentionMarks(block.node, block.text)[0]).toMatchObject({ ordinal: 1 })
  })

  it('keeps two different records apart when they sit side by side', () => {
    const doc: PmDoc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', marks: marked('e1'), text: 'Harlan' },
            { type: 'text', marks: marked('e2'), text: 'Mira' }
          ]
        }
      ]
    }
    const block = extractRawBlocks(doc)[0]!
    expect(extractMentionMarks(block.node, block.text).map((m) => m.entityId)).toEqual(['e1', 'e2'])
  })
})

describe('extractDocumentMentions', () => {
  const doc: PmDoc = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Harlan went north' }] },
      { type: 'paragraph' },
      { type: 'paragraph', content: [{ type: 'text', text: 'Nobody followed Harlan.' }] }
    ]
  }

  it('returns blocks whose text the offsets actually address', () => {
    const { blocks, mentions } = extractDocumentMentions(doc, { forms: formsFor(harlan) })
    expect(blocks).toHaveLength(3)
    for (const mention of mentions) {
      const block = blocks.find((candidate) => candidate.index === mention.blockIndex)!
      expect(block.text.slice(mention.start, mention.end)).toBe(mention.surface)
    }
  })

  it('finds a suggestion per block', () => {
    const { mentions } = extractDocumentMentions(doc, { forms: formsFor(harlan) })
    expect(mentions.map((m) => m.blockIndex)).toEqual([0, 2])
    expect(mentions.every((m) => !m.confirmed)).toBe(true)
  })

  it('silences a dismissed surface', () => {
    const { mentions } = extractDocumentMentions(doc, {
      forms: formsFor(harlan),
      dismissed: new Set([dismissKey('e1', 'Harlan')])
    })
    expect(mentions).toEqual([])
  })

  it('caps stored suggestions per record per document', () => {
    const many: PmDoc = {
      type: 'doc',
      content: Array.from({ length: 10 }, () => ({
        type: 'paragraph',
        content: [{ type: 'text', text: 'Harlan.' }]
      }))
    }
    const { mentions } = extractDocumentMentions(many, { forms: formsFor(harlan), maxPerEntity: 4 })
    expect(mentions).toHaveLength(4)
  })

  it('produces nothing at all when the roster is empty', () => {
    const { blocks, mentions } = extractDocumentMentions(doc, { forms: [] })
    expect(mentions).toEqual([])
    expect(blocks).toHaveLength(3)
  })
})
