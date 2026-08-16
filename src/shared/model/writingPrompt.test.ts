import { describe, it, expect } from 'vitest'
import {
  pickAngle,
  isFresh,
  today,
  promptRequest,
  PROMPT_ANGLES,
  EMPTY_DAILY_PROMPT
} from './writingPrompt.js'

describe('pickAngle', () => {
  it('never repeats yesterday’s angle', () => {
    // The one repetition a daily reader reads as a bug rather than as chance.
    for (const previous of PROMPT_ANGLES) {
      for (const roll of [0, 0.5, 0.999]) {
        expect(pickAngle(previous, () => roll)).not.toBe(previous)
      }
    }
  })

  it('still picks something when there is no previous angle', () => {
    expect(PROMPT_ANGLES).toContain(pickAngle('', () => 0))
  })

  it('stays in range at the top of the roll', () => {
    // Math.random() can return values arbitrarily close to 1; an off-by-one
    // here would hand the welcome screen an undefined angle once in a while.
    expect(pickAngle('', () => 0.9999999)).toBeTruthy()
  })
})

describe('isFresh', () => {
  it('is stale on another day', () => {
    expect(isFresh({ date: '2026-01-01', text: 'Write something.', angle: 'x' }, '2026-01-02')).toBe(
      false
    )
  })

  it('is stale when the text is empty, even today', () => {
    // A failed request must not pin an empty card in place until midnight.
    expect(isFresh({ ...EMPTY_DAILY_PROMPT, date: today() })).toBe(false)
  })

  it('is fresh for today with text', () => {
    expect(isFresh({ date: today(), text: 'A door.', angle: 'x' })).toBe(true)
  })
})

describe('today', () => {
  it('is the local calendar day, which is what daily means to a person', () => {
    expect(today(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05')
  })
})

describe('promptRequest', () => {
  it('carries the angle and asks for the prompt alone', () => {
    const request = promptRequest('a door that will not close')
    expect(request).toContain('a door that will not close')
    expect(request).toMatch(/no preamble/i)
  })
})
