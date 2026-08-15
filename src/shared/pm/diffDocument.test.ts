import { describe, it, expect } from 'vitest'
import { diffBlocks, diffWords, similarity, type BlockDiffEntry } from './diffDocument.js'
import { diffSequences } from './lcsDiff.js'
import type { TextBlock } from './extractText.js'

/**
 * Comparing two versions of a document.
 *
 * The move and edit cases are the whole reason this module exists on top of
 * `lcsDiff`, so each is tested twice: once showing what the sequence diff alone
 * reports, and once showing what this makes of it. The first half of each pair
 * is not redundant — it is the record of what the reclassification is for, and
 * it fails the moment someone decides the extra pass is not needed.
 */

function blocks(...texts: string[]): TextBlock[] {
  return texts.map((text, index) => ({ index, type: 'paragraph', text }))
}

function kinds(entries: readonly BlockDiffEntry[]): string[] {
  return entries.map((entry) => entry.kind)
}

function textOf(entries: readonly BlockDiffEntry[], kind: string): string[] {
  return entries.filter((entry) => entry.kind === kind).map((entry) => entry.text)
}

describe('an untouched document', () => {
  it('is all unchanged', () => {
    const same = blocks('One.', 'Two.', 'Three.')
    expect(kinds(diffBlocks(same, same))).toEqual(['unchanged', 'unchanged', 'unchanged'])
  })

  it('copes with a document that has become empty, and one that was', () => {
    expect(kinds(diffBlocks(blocks('One.'), []))).toEqual(['removed'])
    expect(kinds(diffBlocks([], blocks('One.')))).toEqual(['added'])
    expect(diffBlocks([], [])).toEqual([])
  })
})

describe('a paragraph that moved', () => {
  const before = blocks('Alpha.', 'Bravo.', 'Charlie.')
  const after = blocks('Bravo.', 'Charlie.', 'Alpha.')

  /*
   * The baseline, kept deliberately. A sequence diff has no idea a paragraph
   * travelled: it sees one gone from the top and an unrelated one arrived at
   * the bottom. Reading that, an author cannot tell a reordering from a
   * rewrite.
   */
  it('is a delete and an insert to the sequence diff alone', () => {
    const ops = diffSequences(before, after, (x, y) => x.text === y.text)
    expect(ops.map((op) => op.type)).toEqual(['delete', 'equal', 'insert'])
    expect(ops[0]!.items.map((item) => item.text)).toEqual(['Alpha.'])
    expect(ops[2]!.items.map((item) => item.text)).toEqual(['Alpha.'])
  })

  it('is one move once the blocks are reconciled', () => {
    const entries = diffBlocks(before, after)
    expect(kinds(entries)).toEqual(['unchanged', 'unchanged', 'moved'])
    const moved = entries.find((entry) => entry.kind === 'moved')!
    expect(moved.text).toBe('Alpha.')
    // Carrying both ends of the journey, so the view can say where it went.
    expect(moved.oldIndex).toBe(0)
    expect(moved.newIndex).toBe(2)
  })

  it('never reports the moved paragraph as lost or arrived', () => {
    const entries = diffBlocks(before, after)
    expect(textOf(entries, 'removed')).toEqual([])
    expect(textOf(entries, 'added')).toEqual([])
  })

  it('says where a paragraph was and where it is, not where it merely used to sit', () => {
    // Every row's indices are read from the side it belongs to. Taking them
    // from the op's own blocks would report an untouched paragraph as still
    // being at its old position, which is wrong the moment anything above it
    // was added or cut.
    const entries = diffBlocks(before, after)
    expect(entries.map((entry) => [entry.text, entry.oldIndex, entry.newIndex])).toEqual([
      ['Bravo.', 1, 0],
      ['Charlie.', 2, 1],
      ['Alpha.', 0, 2]
    ])
  })

  /*
   * Duplicated text must not produce a crossed or invented journey. Only the
   * paragraph that genuinely had to move is reported as moving — the other copy
   * stayed where it was and is left alone.
   */
  it('moves only the duplicate that actually travelled', () => {
    const entries = diffBlocks(
      blocks('Same.', 'A.', 'Same.', 'B.'),
      blocks('A.', 'Same.', 'B.', 'Same.')
    )
    const moved = entries.filter((entry) => entry.kind === 'moved')
    expect(moved).toHaveLength(1)
    expect(moved[0]).toMatchObject({ text: 'Same.', oldIndex: 0, newIndex: 3 })
    // And nothing was lost or duplicated in the telling.
    expect(entries.filter((entry) => entry.text === 'Same.')).toHaveLength(2)
  })

  /* A paragraph the sequence diff happened to cut and re-add at the same place
   * did not move, and saying so would be noise. */
  it('does not call a paragraph moved when it ends where it began', () => {
    const entries = diffBlocks(
      blocks('Same.', 'A.', 'B.', 'Same.', 'C.'),
      blocks('A.', 'Same.', 'B.', 'C.', 'Same.')
    )
    const stayed = entries.find((entry) => entry.text === 'B.')!
    expect(stayed.kind).toBe('unchanged')
    expect(stayed.oldIndex).toBe(stayed.newIndex)
  })
})

describe('a paragraph that was edited', () => {
  const before = blocks('The storm broke at dusk.')
  const after = blocks('The storm broke at dawn.')

  it('is an unrelated delete and insert to the sequence diff alone', () => {
    const ops = diffSequences(before, after, (x, y) => x.text === y.text)
    expect(ops.map((op) => op.type)).toEqual(['delete', 'insert'])
  })

  it('is one change, diffed word by word, once reconciled', () => {
    const entries = diffBlocks(before, after)
    expect(kinds(entries)).toEqual(['changed'])
    const changed = entries[0]!
    expect(changed.oldIndex).toBe(0)
    expect(changed.newIndex).toBe(0)
    expect(changed.words?.filter((word) => word.kind === 'delete').map((word) => word.text)).toEqual([
      'dusk.'
    ])
    expect(changed.words?.filter((word) => word.kind === 'insert').map((word) => word.text)).toEqual([
      'dawn.'
    ])
  })

  it('leaves the untouched words of an edited paragraph alone', () => {
    const changed = diffBlocks(before, after)[0]!
    const kept = changed.words!.filter((word) => word.kind === 'equal').map((word) => word.text).join('')
    expect(kept).toContain('The storm broke at')
  })
})

/*
 * The threshold, pinned from both sides. Without the lower test it could drift
 * up until real edits started reading as replacements; without the upper one it
 * could drift down until unrelated paragraphs were shown as edits of each other,
 * which is the more confusing failure of the two.
 */
describe('how alike two paragraphs must be to count as one edit', () => {
  it('treats a rewritten sentence that keeps its subject as an edit', () => {
    const entries = diffBlocks(
      blocks('The lighthouse keeper walked the long shore at dawn.'),
      blocks('The lighthouse keeper walked the shore.')
    )
    expect(kinds(entries)).toEqual(['changed'])
  })

  it('treats a genuinely different paragraph as a replacement, not an edit', () => {
    const entries = diffBlocks(
      blocks('The lighthouse keeper walked the long shore at dawn.'),
      blocks('Margaret counted the ledgers twice before speaking.')
    )
    expect(kinds(entries).sort()).toEqual(['added', 'removed'])
  })

  it('scores identical text as one and disjoint text as zero', () => {
    expect(similarity('a b c', 'a b c')).toBe(1)
    expect(similarity('a b c', 'x y z')).toBe(0)
    expect(similarity('', '')).toBe(1)
    expect(similarity('a', '')).toBe(0)
  })

  it('ignores word order, since a reordered clause is still the same sentence', () => {
    expect(similarity('the storm broke at dusk', 'at dusk the storm broke')).toBe(1)
  })
})

describe('diffWords', () => {
  it('rebuilds both sides exactly, whitespace included', () => {
    const entries = diffWords('one two  three', 'one four three')
    const before = entries.filter((e) => e.kind !== 'insert').map((e) => e.text).join('')
    const after = entries.filter((e) => e.kind !== 'delete').map((e) => e.text).join('')
    expect(before).toBe('one two  three')
    expect(after).toBe('one four three')
  })

  it('says nothing about identical text beyond that it is equal', () => {
    expect(diffWords('same words', 'same words')).toEqual([{ kind: 'equal', text: 'same words' }])
  })

  it('handles one side being empty', () => {
    expect(diffWords('', 'new words')).toEqual([{ kind: 'insert', text: 'new words' }])
    expect(diffWords('gone', '')).toEqual([{ kind: 'delete', text: 'gone' }])
  })
})

describe('several changes at once', () => {
  it('tells a move, an edit, an addition and a removal apart in one document', () => {
    const entries = diffBlocks(
      blocks('Travels.', 'Edited at dusk.', 'Deleted.', 'Kept.'),
      blocks('Edited at dawn.', 'Kept.', 'Added.', 'Travels.')
    )
    expect(entries.filter((entry) => entry.kind === 'moved').map((entry) => entry.text)).toEqual([
      'Travels.'
    ])
    expect(entries.filter((entry) => entry.kind === 'changed').map((entry) => entry.text)).toEqual([
      'Edited at dawn.'
    ])
    expect(textOf(entries, 'removed')).toEqual(['Deleted.'])
    expect(textOf(entries, 'added')).toEqual(['Added.'])
    expect(textOf(entries, 'unchanged')).toEqual(['Kept.'])
  })

  /* Every paragraph of the new version has to appear exactly once, whatever it
   * was classified as — a diff that loses a paragraph is worse than no diff. */
  it('accounts for every paragraph on both sides', () => {
    const before = blocks('A.', 'B at dusk.', 'C.', 'D.')
    const after = blocks('C.', 'B at dawn.', 'E.', 'A.')
    const entries = diffBlocks(before, after)

    const present = entries
      .filter((entry) => entry.newIndex !== null && entry.kind !== 'removed')
      .map((entry) => entry.text)
      .sort()
    expect(present).toEqual(['A.', 'B at dawn.', 'C.', 'E.'])

    const gone = entries.filter((entry) => entry.kind === 'removed').map((entry) => entry.text)
    expect(gone).toEqual(['D.'])
  })
})
