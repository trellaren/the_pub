import { describe, it, expect } from 'vitest'
import {
  assistantProfile,
  isAssistantAuthor,
  describeAuthor,
  colorForAuthor,
  ASSISTANT_COLOR,
  AUTHOR_COLORS
} from './author.js'

describe('assistantProfile', () => {
  it('derives a stable id from the owner so two collaborators get two assistants', () => {
    const mine = assistantProfile({ id: 'owner-a', name: 'A', color: '' })
    const theirs = assistantProfile({ id: 'owner-b', name: 'B', color: '' })
    expect(mine.id).not.toBe(theirs.id)
    expect(mine).toEqual(assistantProfile({ id: 'owner-a', name: 'renamed', color: '#fff' }))
  })

  it('is a legal filename on every platform', () => {
    expect(assistantProfile({ id: 'owner', name: '', color: '' }).id).toMatch(/^[\w-]+$/)
  })

  it('is recognised as not a person', () => {
    expect(isAssistantAuthor(assistantProfile({ id: 'x', name: '', color: '' }).id)).toBe(true)
    expect(isAssistantAuthor('x')).toBe(false)
    expect(isAssistantAuthor('docx-abc')).toBe(false)
  })

  it('never shares a tint with a person', () => {
    expect(AUTHOR_COLORS).not.toContain(ASSISTANT_COLOR)
    expect(colorForAuthor('assistant-owner')).not.toBe(ASSISTANT_COLOR)
  })
})

describe('describeAuthor', () => {
  it('names an unregistered assistant rather than inventing "Author xxxx"', () => {
    const described = describeAuthor('assistant-owner', [])
    expect(described.name).toBe('Assistant')
    expect(described.color).toBe(ASSISTANT_COLOR)
  })

  it('prefers the registry when the assistant is in it', () => {
    const described = describeAuthor('assistant-owner', [{ id: 'assistant-owner', name: 'Quoth', color: '#000' }])
    expect(described.name).toBe('Quoth')
  })
})
