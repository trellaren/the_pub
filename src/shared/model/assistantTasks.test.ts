import { describe, it, expect } from 'vitest'
import { ASSISTANT_TASKS, availableTasks } from './assistantTasks.js'

describe('availableTasks', () => {
  it('offers only what can run: no document tasks without a document, no research without the web', () => {
    const ids = (state: Parameters<typeof availableTasks>[0]) => availableTasks(state).map((task) => task.id)
    expect(ids({ hasDocument: false, hasSelection: false, web: 'none' })).toEqual(['prompt', 'exercise', 'outline-next', 'brainstorm'])
    expect(ids({ hasDocument: true, hasSelection: false, web: 'none' })).toContain('peer-review')
    expect(ids({ hasDocument: true, hasSelection: false, web: 'none' })).not.toContain('tighten')
    expect(ids({ hasDocument: true, hasSelection: true, web: 'none' })).toContain('tighten')
    expect(ids({ hasDocument: true, hasSelection: true, web: 'none' })).not.toContain('research')
    expect(ids({ hasDocument: true, hasSelection: true, web: 'urls' })).toContain('research')
  })

  it('names the document by path so the model does not have to find it', () => {
    for (const task of ASSISTANT_TASKS.filter((candidate) => candidate.needs === 'document')) {
      expect(task.prompt({ docPath: 'ch1.pubdoc', angle: '' })).toContain('ch1.pubdoc')
    }
  })

  it('routes every prose-changing task through suggest_edit, never a paste', () => {
    for (const id of ['tighten', 'continue']) {
      expect(ASSISTANT_TASKS.find((task) => task.id === id)!.prompt({ docPath: 'x', angle: '' })).toContain('suggest_edit')
    }
  })
})
