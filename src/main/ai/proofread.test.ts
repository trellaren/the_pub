import { describe, it, expect } from 'vitest'
import { chunkBlocks, parseFindings, proofreadPrompt, describeFindings } from './proofread.js'
import type { TextBlock } from '../../shared/pm/extractText.js'

const blocks: TextBlock[] = [
  { index: 0, type: 'paragraph', text: 'The harbour was quiet, the the gulls gone.' },
  { index: 1, type: 'paragraph', text: '' },
  { index: 2, type: 'paragraph', text: 'She recieved no answer.' },
  { index: 3, type: 'paragraph', text: 'It was it was late.' }
]

describe('chunkBlocks', () => {
  it('keeps whole blocks and skips empty ones', () => {
    const chunks = chunkBlocks(blocks, 60)
    expect(chunks.map((chunk) => chunk.map((block) => block.index))).toEqual([[0], [2, 3]])
  })

  it('never splits a block, even one longer than the budget', () => {
    const long: TextBlock = { index: 0, type: 'paragraph', text: 'x'.repeat(100) }
    expect(chunkBlocks([long, blocks[2]!], 10)).toEqual([[long], [blocks[2]]])
  })
})

describe('proofreadPrompt', () => {
  it('numbers each block by its document index so a finding can be placed', () => {
    const { user, system } = proofreadPrompt([blocks[0]!, blocks[2]!], ['spelling'], 'en-GB')
    expect(user).toContain('[0] The harbour')
    expect(user).toContain('[2] She recieved')
    expect(system).toContain('en-GB')
    expect(system).toContain('spelling')
  })
})

describe('parseFindings', () => {
  it('places a finding whose words occur once in the block it names', () => {
    const { placed, dropped } = parseFindings(
      JSON.stringify([{ block: 2, find: 'recieved', replace: 'received', reason: 'misspelt', kind: 'spelling' }]),
      blocks
    )
    expect(dropped).toBe(0)
    expect(placed).toEqual([
      {
        kind: 'spelling',
        op: { kind: 'replace', blockIndex: 2, start: 4, end: 12, text: 'received', reason: 'spelling: misspelt' }
      }
    ])
  })

  it('drops a finding quoting words that are not in the block — the model misquoted', () => {
    const { placed, dropped } = parseFindings(
      JSON.stringify([{ block: 2, find: 'recieve', replace: 'receive', kind: 'spelling' }, { block: 2, find: 'no reply', replace: 'no answer' }]),
      blocks
    )
    expect(placed).toHaveLength(1)
    expect(dropped).toBe(1)
  })

  it('drops a finding whose words occur twice rather than guessing which', () => {
    const { placed, dropped } = parseFindings(JSON.stringify([{ block: 3, find: 'it was', replace: 'it was', kind: 'grammar' }]), blocks)
    expect(placed).toHaveLength(0)
    expect(dropped).toBe(1)
  })

  it('drops a finding addressed to a block outside the chunk, a no-op, and overlapping duplicates', () => {
    const { placed, dropped } = parseFindings(
      JSON.stringify([
        { block: 9, find: 'x', replace: 'y' },
        { block: 0, find: 'quiet', replace: 'quiet' },
        { block: 0, find: 'the the', replace: 'the', kind: 'grammar' },
        { block: 0, find: 'the the gulls', replace: 'the gulls', kind: 'grammar' }
      ]),
      blocks
    )
    expect(placed.map((finding) => finding.op.text)).toEqual(['the'])
    expect(dropped).toBe(3)
  })

  it('reads JSON out of a fenced or chatty reply, and an unparseable one as nothing', () => {
    const chatty = 'Here you go:\n```json\n[{"block":2,"find":"recieved","replace":"received"}]\n```\nHope that helps.'
    expect(parseFindings(chatty, blocks).placed).toHaveLength(1)
    expect(parseFindings('I found nothing wrong.', blocks)).toEqual({ placed: [], dropped: 0 })
    expect(parseFindings('[not json', blocks)).toEqual({ placed: [], dropped: 0 })
  })
})

describe('describeFindings', () => {
  it('counts by kind in a fixed order', () => {
    const { placed } = parseFindings(
      JSON.stringify([
        { block: 2, find: 'recieved', replace: 'received', kind: 'spelling' },
        { block: 0, find: 'the the', replace: 'the', kind: 'grammar' },
        { block: 0, find: 'quiet,', replace: 'quiet;', kind: 'punctuation' }
      ]),
      blocks
    )
    expect(describeFindings(placed)).toBe('3 suggestions (1 spelling, 1 grammar, 1 punctuation)')
    expect(describeFindings([])).toBe('no corrections')
  })
})
