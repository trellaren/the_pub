import { describe, it, expect } from 'vitest'
import {
  forEachTextNode,
  extractRawBlocks,
  normalizeBlockText,
  extractBlocks,
  type RawTextNode
} from './extractText.js'
import type { PmDoc, PmNode } from '../model/document.js'

/** A block of every awkward shape at once: bold splits, a hard break, a list. */
const doc: PmDoc = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: '  Har' },
        { type: 'text', marks: [{ type: 'bold' }], text: 'lan' },
        { type: 'hardBreak' },
        { type: 'text', text: 'went north  ' }
      ]
    },
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second' }] }] }
      ]
    },
    { type: 'paragraph' }
  ]
}

function collect(node: PmNode): RawTextNode[] {
  const entries: RawTextNode[] = []
  forEachTextNode(node, (entry) => entries.push(entry))
  return entries
}

describe('forEachTextNode', () => {
  it('reports offsets that slice the raw text back out', () => {
    // This equality is the contract the rest of the mention code rests on: the
    // walker and the raw block text must agree character for character.
    for (const block of extractRawBlocks(doc)) {
      for (const entry of collect(block.node)) {
        expect(block.text.slice(entry.start, entry.end)).toBe(entry.text)
      }
    }
  })

  it('accounts for the separators between nested blocks', () => {
    const list = extractRawBlocks(doc)[1]!
    const entries = collect(list.node)
    expect(entries.map((entry) => entry.text)).toEqual(['first', 'second'])
    // 'first' is 5 long and a newline separates the items, so 'second' starts at 6.
    expect(entries[1]!.start).toBe(6)
    expect(list.text).toBe('first\nsecond')
  })

  it('gives a hard break one character of width', () => {
    const entries = collect(extractRawBlocks(doc)[0]!.node)
    const brk = entries.find((entry) => entry.node.type === 'hardBreak')!
    expect(brk.end - brk.start).toBe(1)
  })

  it('hands back the slot each node occupies', () => {
    const paragraph = extractRawBlocks(doc)[0]!.node
    const entries = collect(paragraph)
    expect(entries[0]!.parent).toBe(paragraph.content)
    expect(entries[0]!.parent[entries[0]!.index]).toBe(entries[0]!.node)
  })

  it('visits nothing in an empty block', () => {
    expect(collect({ type: 'paragraph' })).toEqual([])
  })
})

describe('normalizeBlockText', () => {
  const cases = [
    '',
    '   ',
    'plain',
    '  Harlan\nwent north  ',
    'first\nsecond',
    'a\n\n\nb',
    '\nleading',
    'trailing\n',
    '\n\n',
    'tabs\tand  spaces'
  ]

  it('produces exactly the text the old expression did', () => {
    for (const raw of cases) {
      expect(normalizeBlockText(raw).text).toBe(raw.replace(/\n+/g, ' ').trim())
    }
  })

  it('maps every normalised character back to the character it came from', () => {
    for (const raw of cases) {
      const { text, map } = normalizeBlockText(raw)
      for (let i = 0; i < text.length; i++) {
        const source = raw[map[i]!]!
        // A collapsed newline run is the one case where the characters differ.
        if (text[i] === ' ' && source === '\n') continue
        expect(source).toBe(text[i])
      }
    }
  })

  it('round-trips normalised offsets through both maps', () => {
    for (const raw of cases) {
      const { text, map, unmap } = normalizeBlockText(raw)
      for (let i = 0; i <= text.length; i++) {
        expect(unmap[map[i]!]).toBe(i)
      }
    }
  })

  it('collapses a newline run to one space with the whole run as its source', () => {
    const { text, map } = normalizeBlockText('a\n\n\nb')
    expect(text).toBe('a b')
    expect(map[1]).toBe(1) // the space points at the first newline
    expect(map[2]).toBe(4) // 'b'
    expect(map[3]).toBe(5) // one past the end
  })

  it('shifts offsets past trimmed leading whitespace', () => {
    const raw = '  Harlan\nwent north  '
    const { text, map } = normalizeBlockText(raw)
    expect(text).toBe('Harlan went north')
    const at = text.indexOf('Harlan')
    expect(map[at]).toBe(2)
    expect(raw.slice(map[at]!, map[at + 'Harlan'.length]!)).toBe('Harlan')
  })

  it('survives text that normalises away entirely', () => {
    const { text, map, unmap } = normalizeBlockText('  \n \n ')
    expect(text).toBe('')
    expect(map).toHaveLength(1)
    expect(unmap[unmap.length - 1]).toBe(0)
  })
})

describe('extractBlocks on top of the shared path', () => {
  it('normalises through the same code the maps come from', () => {
    const blocks = extractBlocks(doc)
    expect(blocks[0]!.text).toBe('Harlan went north')
    expect(blocks[1]!.text).toBe('first second')
    expect(blocks[2]!.text).toBe('')
  })

  it('agrees with normalizeBlockText applied to the raw blocks', () => {
    const raws = extractRawBlocks(doc)
    const blocks = extractBlocks(doc)
    for (let i = 0; i < raws.length; i++) {
      expect(blocks[i]!.text).toBe(normalizeBlockText(raws[i]!.text).text)
    }
  })
})
