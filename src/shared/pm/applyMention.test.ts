import { describe, it, expect } from 'vitest'
import { applyMentionMark } from './applyMention.js'
import { extractDocumentMentions, buildScanForms } from './mentions.js'
import { extractBlocks } from './extractText.js'
import { storyEntitySchema } from '../model/entity.js'
import type { PmDoc } from '../model/document.js'

const harlan = storyEntitySchema.parse({
  id: 'e1',
  kind: 'character',
  name: 'Harlan',
  created: '2026-01-01T00:00:00.000Z',
  modified: '2026-01-01T00:00:00.000Z'
})
const attrs = { entityId: 'e1', entityKind: 'character' }

const plain: PmDoc = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Harlan went north' }] },
    { type: 'paragraph', content: [{ type: 'text', text: "Harlan told Harlan's brother" }] }
  ]
}

describe('applyMentionMark', () => {
  it('marks the occurrence and leaves the text identical', () => {
    const next = applyMentionMark(plain, 0, 'Harlan', 0, attrs)!
    // The single most important property: prose is unchanged by confirming.
    expect(extractBlocks(next).map((b) => b.text)).toEqual(extractBlocks(plain).map((b) => b.text))
    expect(next.content![0]!.content).toEqual([
      { type: 'text', text: 'Harlan', marks: [{ type: 'mention', attrs }] },
      { type: 'text', text: ' went north' }
    ])
  })

  it('does not mutate the document it was given', () => {
    const before = structuredClone(plain)
    applyMentionMark(plain, 0, 'Harlan', 0, attrs)
    expect(plain).toEqual(before)
  })

  it('marks the occurrence the ordinal names, not the first one', () => {
    const next = applyMentionMark(plain, 1, 'Harlan', 1, attrs)!
    const pieces = next.content![1]!.content!
    expect(pieces[0]).toEqual({ type: 'text', text: 'Harlan told ' })
    expect(pieces[1]).toMatchObject({ text: 'Harlan', marks: [{ type: 'mention', attrs }] })
    expect(pieces[2]).toEqual({ type: 'text', text: "'s brother" })
  })

  it('marks every text node a name is split across', () => {
    const split: PmDoc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Har' },
            { type: 'text', marks: [{ type: 'bold' }], text: 'lan' },
            { type: 'text', text: ' went north' }
          ]
        }
      ]
    }
    const next = applyMentionMark(split, 0, 'Harlan', 0, attrs)!
    const pieces = next.content![0]!.content!
    expect(pieces[0]!.marks).toEqual([{ type: 'mention', attrs }])
    // The bold run keeps its bold and gains the mention.
    expect(pieces[1]!.marks).toEqual([{ type: 'bold' }, { type: 'mention', attrs }])
    expect(extractBlocks(next)[0]!.text).toBe('Harlan went north')
  })

  it('finds an occurrence past a hard break, in normalised coordinates', () => {
    const broken: PmDoc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '  Nobody saw' },
            { type: 'hardBreak' },
            { type: 'text', text: 'Harlan leave  ' }
          ]
        }
      ]
    }
    const next = applyMentionMark(broken, 0, 'Harlan', 0, attrs)!
    const marked = next.content![0]!.content!.find((node) => node.marks?.some((m) => m.type === 'mention'))
    expect(marked).toMatchObject({ text: 'Harlan' })
    expect(extractBlocks(next)[0]!.text).toBe('Nobody saw Harlan leave')
  })

  it('replaces an existing mention rather than stacking a second', () => {
    const already = applyMentionMark(plain, 0, 'Harlan', 0, attrs)!
    const again = applyMentionMark(already, 0, 'Harlan', 0, { entityId: 'e2' })!
    expect(again.content![0]!.content![0]!.marks).toEqual([
      { type: 'mention', attrs: { entityId: 'e2' } }
    ])
  })

  it('returns null when the occurrence is gone', () => {
    expect(applyMentionMark(plain, 0, 'Mira', 0, attrs)).toBeNull()
    expect(applyMentionMark(plain, 0, 'Harlan', 3, attrs)).toBeNull()
    expect(applyMentionMark(plain, 9, 'Harlan', 0, attrs)).toBeNull()
  })
})

describe('scan then promote', () => {
  const forms = buildScanForms([harlan])

  it('turns one suggestion into one confirmed mention at the same offsets', () => {
    const before = extractDocumentMentions(plain, { forms })
    const suggestion = before.mentions.find((m) => m.blockIndex === 1 && m.ordinal === 1)!
    expect(suggestion.confirmed).toBe(false)

    const next = applyMentionMark(plain, 1, suggestion.surface, suggestion.ordinal, attrs)!
    const after = extractDocumentMentions(next, { forms })

    const promoted = after.mentions.find((m) => m.confirmed)!
    expect(promoted).toMatchObject({
      entityId: 'e1',
      blockIndex: suggestion.blockIndex,
      start: suggestion.start,
      end: suggestion.end,
      ordinal: suggestion.ordinal,
      surface: suggestion.surface
    })

    // One fewer suggestion, and the other occurrence in that block survives.
    expect(after.mentions.filter((m) => !m.confirmed)).toHaveLength(
      before.mentions.filter((m) => !m.confirmed).length - 1
    )
    expect(after.mentions.filter((m) => m.blockIndex === 1)).toHaveLength(2)
  })

  it('leaves the indexed block text byte-identical', () => {
    const next = applyMentionMark(plain, 1, 'Harlan', 0, attrs)!
    expect(extractDocumentMentions(next, { forms }).blocks).toEqual(
      extractDocumentMentions(plain, { forms }).blocks
    )
  })
})
