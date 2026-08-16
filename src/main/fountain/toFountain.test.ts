import { describe, it, expect } from 'vitest'
import { exportFountain } from './toFountain.js'
import {
  STYLE_SCENE_HEADING,
  STYLE_ACTION,
  STYLE_CHARACTER,
  STYLE_PARENTHETICAL,
  STYLE_DIALOGUE,
  STYLE_TRANSITION
} from '../../shared/model/style.js'
import type { PmDoc, PmNode } from '../../shared/model/document.js'

function para(styleId: string, text: string): PmNode {
  return { type: 'paragraph', attrs: { styleId }, content: [{ type: 'text', text }] }
}

function doc(...blocks: PmNode[]): PmDoc {
  return { type: 'doc', content: blocks }
}

describe('exportFountain', () => {
  it('emits a Title line and a blank line before the body when given a title', () => {
    const text = exportFountain(doc(para(STYLE_ACTION, 'Rain.')), { title: 'The Long Way Home' })
    expect(text.startsWith('Title: The Long Way Home\n\n')).toBe(true)
  })

  it('emits no title page when no title is given', () => {
    expect(exportFountain(doc(para(STYLE_ACTION, 'Rain.')))).not.toContain('Title:')
  })

  it('forces a scene heading that does not already read as one', () => {
    expect(exportFountain(doc(para(STYLE_SCENE_HEADING, 'THE ABANDONED MILL')))).toContain('.THE ABANDONED MILL')
  })

  it('does not force a scene heading that already carries a recognised prefix', () => {
    const text = exportFountain(doc(para(STYLE_SCENE_HEADING, 'INT. KITCHEN - NIGHT')))
    expect(text).toContain('INT. KITCHEN - NIGHT')
    expect(text).not.toContain('.INT.')
  })

  it('always forces a transition, so any phrasing round-trips', () => {
    expect(exportFountain(doc(para(STYLE_TRANSITION, 'DISSOLVE TO BLACK.')))).toContain('>DISSOLVE TO BLACK.')
  })

  it('uppercases a character cue', () => {
    expect(exportFountain(doc(para(STYLE_CHARACTER, 'Mara')))).toContain('MARA')
  })

  it('wraps a parenthetical in parens unless it already has them', () => {
    expect(exportFountain(doc(para(STYLE_PARENTHETICAL, 'beat')))).toContain('(beat)')
    expect(exportFountain(doc(para(STYLE_PARENTHETICAL, '(already wrapped)')))).toContain('(already wrapped)\n')
  })

  it('keeps a cue and its dialogue contiguous, but blank-separates unrelated elements', () => {
    const text = exportFountain(
      doc(
        para(STYLE_SCENE_HEADING, 'INT. KITCHEN - NIGHT'),
        para(STYLE_ACTION, 'Rain against the window.'),
        para(STYLE_CHARACTER, 'Mara'),
        para(STYLE_DIALOGUE, 'I thought you left already.'),
        para(STYLE_PARENTHETICAL, 'beat'),
        para(STYLE_DIALOGUE, 'I heard the car.')
      )
    )
    const lines = text.trimEnd().split('\n')
    expect(lines).toEqual([
      'INT. KITCHEN - NIGHT',
      '',
      'Rain against the window.',
      '',
      'MARA',
      'I thought you left already.',
      '(beat)',
      'I heard the car.'
    ])
  })

  it('skips a block with no text rather than emitting a stray blank element', () => {
    expect(exportFountain(doc({ type: 'paragraph', attrs: { styleId: STYLE_ACTION }, content: [] }))).toBe('\n')
  })
})
