import { describe, it, expect } from 'vitest'
import type { z } from 'zod'
import { applyAssistantEdit, assistantEditSchema, type AssistantEdit } from './assistantEdits.js'
import { listSuggestions, resolveSuggestions } from './suggestions.js'
import { extractBlocks, extractPlainText } from './extractText.js'
import { findAnchor } from './anchors.js'
import { pmDocSchema, type PmDoc } from '../model/document.js'

const doc: PmDoc = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'The harbour was quiet.' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'A ' },
        { type: 'text', marks: [{ type: 'bold' }], text: 'stormy' },
        { type: 'text', text: ' night fell.' }
      ]
    },
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'First line' }, { type: 'hardBreak' }, { type: 'text', text: 'second line' }]
    },
    { type: 'paragraph' }
  ]
}

function edit(ops: z.input<typeof assistantEditSchema>['ops'], mode: AssistantEdit['mode'] = 'suggest'): AssistantEdit {
  return assistantEditSchema.parse({
    id: 'e1',
    runId: 'run-1',
    docId: 'doc-1',
    docPath: 'scene.pubdoc',
    authorId: 'assistant-owner',
    model: 'stub',
    at: '2026-10-02T00:00:00.000Z',
    mode,
    ops
  })
}

describe('applyAssistantEdit in suggest mode', () => {
  it('strikes the old text through and inserts the new under the assistant mark', () => {
    const { doc: out, failed } = applyAssistantEdit(
      doc,
      edit([{ kind: 'replace', blockIndex: 0, start: 12, end: 15, text: 'lay' }])
    )

    expect(failed).toEqual([])
    const pending = listSuggestions(out)
    expect(pending).toEqual([
      expect.objectContaining({ mark: 'deletion', authorId: 'assistant-owner', text: 'was' }),
      expect.objectContaining({ mark: 'insertion', authorId: 'assistant-owner', text: 'lay' })
    ])
    // The walker reads the document as-if-accepted, so the text already reads the new way…
    expect(extractBlocks(out)[0]!.text).toBe('The harbour lay quiet.')
    // …and rejecting restores the original exactly.
    expect(extractPlainText(resolveSuggestions(out, false))).toBe(extractPlainText(doc))
    expect(pmDocSchema.safeParse(out).success).toBe(true)
  })

  it('leaves the original document untouched', () => {
    const before = JSON.stringify(doc)
    applyAssistantEdit(doc, edit([{ kind: 'replace', blockIndex: 0, start: 0, end: 3, text: 'A' }]))
    expect(JSON.stringify(doc)).toBe(before)
  })

  it('carries formatting but not identity onto the inserted text', () => {
    const marked: PmDoc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              marks: [{ type: 'italic' }, { type: 'mention', attrs: { entityId: 'e1' } }],
              text: 'Marta'
            }
          ]
        }
      ]
    }
    const { doc: out } = applyAssistantEdit(marked, edit([{ kind: 'replace', blockIndex: 0, start: 0, end: 5, text: 'Marta Reyes' }]))
    const inserted = out.content![0]!.content!.find((node) => node.marks?.some((mark) => mark.type === 'insertion'))!
    expect(inserted.marks!.map((mark) => mark.type)).toEqual(['italic', 'aiAuthored', 'insertion'])
  })

  it('spans a bold run split across text nodes', () => {
    const { doc: out, failed } = applyAssistantEdit(
      doc,
      edit([{ kind: 'replace', blockIndex: 1, start: 2, end: 14, text: 'calm evening' }])
    )
    expect(failed).toEqual([])
    expect(extractBlocks(out)[1]!.text).toBe('A calm evening fell.')
    expect(listSuggestions(out).filter((s) => s.mark === 'deletion').map((s) => s.text)).toEqual(['stormy night'])
  })

  it('addresses offsets in normalised text even across a hard break', () => {
    const { doc: out, failed } = applyAssistantEdit(
      doc,
      edit([{ kind: 'replace', blockIndex: 2, start: 11, end: 17, text: 'another' }])
    )
    expect(failed).toEqual([])
    expect(extractBlocks(out)[2]!.text).toBe('First line another line')
  })

  it('inserts at an offset without striking anything through', () => {
    const { doc: out } = applyAssistantEdit(
      doc,
      edit([{ kind: 'replace', blockIndex: 0, start: 22, end: 22, text: ' Gulls wheeled.' }])
    )
    expect(extractBlocks(out)[0]!.text).toBe('The harbour was quiet. Gulls wheeled.')
    expect(listSuggestions(out).map((s) => s.mark)).toEqual(['insertion'])
  })

  it('fills an empty paragraph', () => {
    const { doc: out, failed } = applyAssistantEdit(doc, edit([{ kind: 'replace', blockIndex: 3, start: 0, end: 0, text: 'New words.' }]))
    expect(failed).toEqual([])
    expect(extractBlocks(out)[3]!.text).toBe('New words.')
  })

  it('appends paragraphs at the end, each under the insertion mark', () => {
    const { doc: out } = applyAssistantEdit(doc, edit([{ kind: 'append', text: 'One more.\n\nAnd another.' }]))
    const blocks = extractBlocks(out)
    expect(blocks.slice(-2).map((block) => block.text)).toEqual(['One more.', 'And another.'])
    expect(listSuggestions(out)).toHaveLength(2)
  })

  it('applies several ops in one block without the first shifting the second', () => {
    const { doc: out, failed } = applyAssistantEdit(
      doc,
      edit([
        { kind: 'replace', blockIndex: 0, start: 0, end: 3, text: 'That' },
        { kind: 'replace', blockIndex: 0, start: 12, end: 15, text: 'lay' }
      ])
    )
    expect(failed).toEqual([])
    expect(extractBlocks(out)[0]!.text).toBe('That harbour lay quiet.')
  })

  it('applies an anchor op through the shared anchor code', () => {
    const { doc: out } = applyAssistantEdit(doc, edit([{ kind: 'anchor', blockIndex: 0, start: 4, end: 11, anchorId: 'a1' }]))
    expect(findAnchor(out, 'a1')).toMatchObject({ blockIndex: 0, text: 'harbour' })
  })

  it('reports the ops it could not apply and applies the rest', () => {
    const { doc: out, failed } = applyAssistantEdit(
      doc,
      edit([
        { kind: 'replace', blockIndex: 9, start: 0, end: 1, text: 'x' },
        { kind: 'replace', blockIndex: 0, start: 12, end: 15, text: 'lay' },
        { kind: 'replace', blockIndex: 0, start: 5, end: 3, text: 'x' }
      ])
    )
    expect(failed).toEqual([0, 2])
    expect(extractBlocks(out)[0]!.text).toBe('The harbour lay quiet.')
  })
})

describe('applyAssistantEdit in direct mode', () => {
  it('splices the text in with no suggestion marks', () => {
    const { doc: out } = applyAssistantEdit(
      doc,
      edit([{ kind: 'replace', blockIndex: 0, start: 12, end: 15, text: 'lay' }], 'direct')
    )
    expect(extractBlocks(out)[0]!.text).toBe('The harbour lay quiet.')
    expect(listSuggestions(out)).toEqual([])
    expect(out.content![0]!.content!.map((node) => node.text)).toEqual(['The harbour ', 'lay', ' quiet.'])
  })

  it('appends paragraphs carrying only attribution', () => {
    const { doc: out } = applyAssistantEdit(doc, edit([{ kind: 'append', text: 'Plain.' }], 'direct'))
    const last = out.content!.at(-1)!
    expect(last.content![0]!.text).toBe('Plain.')
    expect(last.content![0]!.marks!.map((mark) => mark.type)).toEqual(['aiAuthored'])
  })
})

describe('provenance', () => {
  it('marks every word the assistant wrote and logs one entry per op, in both modes', () => {
    const { doc: out, entries } = applyAssistantEdit(
      doc,
      edit([
        { kind: 'replace', blockIndex: 0, start: 12, end: 15, text: 'lay', reason: 'Tighter.' },
        { kind: 'append', text: 'And so on.' }
      ], 'direct')
    )
    const authored = out.content!.flatMap((block) => block.content ?? []).filter((node) => node.marks?.some((m) => m.type === 'aiAuthored'))
    expect(authored.map((node) => node.text)).toEqual(['lay', 'And so on.'])
    expect(authored[0]!.marks![0]!.attrs).toEqual({ runId: 'run-1', model: 'stub', at: '2026-10-02T00:00:00.000Z', authorId: 'assistant-owner' })
    expect(entries).toEqual([
      expect.objectContaining({ id: 'e1:0', mode: 'direct', blockIndex: 0, chars: 3, excerpt: 'lay', reason: 'Tighter.' }),
      expect.objectContaining({ id: 'e1:1', mode: 'direct', blockIndex: null, chars: 10, excerpt: 'And so on.' })
    ])
  })

  it('keeps attribution under the insertion mark, so accepting a suggestion leaves it behind', () => {
    const { doc: out, entries } = applyAssistantEdit(doc, edit([{ kind: 'replace', blockIndex: 0, start: 12, end: 15, text: 'lay' }]))
    expect(entries[0]).toMatchObject({ mode: 'suggest' })
    const accepted = resolveSuggestions(out, true)
    const node = accepted.content![0]!.content!.find((n) => n.text === 'lay')!
    expect(node.marks!.map((m) => m.type)).toEqual(['aiAuthored'])
  })

  it('logs nothing for an anchor or a failed op', () => {
    const { entries } = applyAssistantEdit(
      doc,
      edit([
        { kind: 'anchor', blockIndex: 0, start: 4, end: 11, anchorId: 'a1' },
        { kind: 'replace', blockIndex: 9, start: 0, end: 1, text: 'x' }
      ])
    )
    expect(entries).toEqual([])
  })
})
