import { describe, it, expect } from 'vitest'
import { importFountain } from './fromFountain.js'
import { SAMPLE_SCREENPLAY, FORCED_MARKERS, CAPS_ACTION_LINE, NO_TITLE_PAGE } from './fixtures.js'
import {
  STYLE_SCENE_HEADING,
  STYLE_ACTION,
  STYLE_CHARACTER,
  STYLE_PARENTHETICAL,
  STYLE_DIALOGUE,
  STYLE_TRANSITION
} from '../../shared/model/style.js'

function styleIds(content: ReturnType<typeof importFountain>['content']): string[] {
  return (content.content ?? []).map((node) => node.attrs?.styleId as string)
}

function texts(content: ReturnType<typeof importFountain>['content']): string[] {
  return (content.content ?? []).map((node) => (node.content ?? []).map((run) => run.text ?? '').join(''))
}

describe('importFountain', () => {
  it('reads the title from the title page', () => {
    expect(importFountain(SAMPLE_SCREENPLAY).title).toBe('The Long Way Home')
  })

  it('classifies every element in a scene: heading, action, cue, dialogue, parenthetical, transition', () => {
    const { content } = importFountain(SAMPLE_SCREENPLAY)
    expect(styleIds(content)).toEqual([
      STYLE_SCENE_HEADING,
      STYLE_ACTION,
      STYLE_CHARACTER,
      STYLE_DIALOGUE,
      STYLE_PARENTHETICAL,
      STYLE_DIALOGUE,
      STYLE_CHARACTER,
      STYLE_DIALOGUE,
      STYLE_TRANSITION,
      STYLE_SCENE_HEADING,
      STYLE_ACTION
    ])
    expect(texts(content)).toEqual([
      'INT. KITCHEN - NIGHT',
      'Rain against the window. MARA stands at the sink, not moving.',
      'MARA',
      'I thought you left already.',
      'beat',
      'I heard the car.',
      'JOEL',
      'I came back for something.',
      'CUT TO:',
      'EXT. DRIVEWAY - CONTINUOUS',
      'The car sits idling, headlights on.'
    ])
  })

  it('strips the forcing markers from a `.` scene heading and a `>` transition', () => {
    const { content } = importFountain(FORCED_MARKERS)
    expect(styleIds(content)).toEqual([STYLE_SCENE_HEADING, STYLE_ACTION, STYLE_TRANSITION])
    expect(texts(content)).toEqual(['CLOSE ON - THE LETTER', 'We read it over her shoulder.', 'SMASH CUT TO BLACK.'])
    expect(importFountain(FORCED_MARKERS).title).toBeNull()
  })

  it('never mistakes a standalone all-caps action line for a character cue', () => {
    const { content } = importFountain(CAPS_ACTION_LINE)
    expect(styleIds(content)).toEqual([STYLE_SCENE_HEADING, STYLE_ACTION, STYLE_ACTION])
    expect(texts(content)).toEqual(['INT. WAREHOUSE - DAY', 'THE CEILING COLLAPSES.', 'Dust fills the room.'])
  })

  it('parses a screenplay with no title page at all', () => {
    const { content, title } = importFountain(NO_TITLE_PAGE)
    expect(title).toBeNull()
    expect(styleIds(content)).toEqual([STYLE_SCENE_HEADING, STYLE_ACTION])
  })
})
