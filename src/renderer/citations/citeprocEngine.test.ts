import { describe, it, expect } from 'vitest'
import { withEngine, isNoteStyle, type CitationCluster } from './citeprocEngine.js'
import type { CslItem } from '@shared/model/source.js'

const SMITH: CslItem = {
  id: 'smith19',
  type: 'book',
  title: 'A Book',
  author: [{ family: 'Smith', given: 'Jane' }],
  issued: { 'date-parts': [[2019]] }
}
const DIAZ: CslItem = {
  id: 'diaz21',
  type: 'article-journal',
  title: 'An Article',
  author: [{ family: 'Diaz', given: 'Ana' }],
  issued: { 'date-parts': [[2021]] }
}

/**
 * Against the real `citeproc-plus` engine, not a mock — this is the seam
 * `docs/phase-5-plan.md` singled out as the one a per-citation formatter
 * cannot get right: rendering has to see every citation in the document at
 * once to know a repeat citation should shorten. A mock that returns
 * canned strings would pass without proving citeproc is wired up at all.
 */
describe('citeprocEngine', () => {
  it('reports author-date styles as inline, not note', async () => {
    const noteStyle = await withEngine('chicago-author-date', [SMITH], (engine) => isNoteStyle(engine))
    expect(noteStyle).toBe(false)
  })

  it('reports Chicago notes-bibliography as a note style', async () => {
    const noteStyle = await withEngine('chicago-notes-bibliography', [SMITH], (engine) => isNoteStyle(engine))
    expect(noteStyle).toBe(true)
  })

  it('renders a citation group in author-date form', async () => {
    const clusters: CitationCluster[] = [
      { citationID: 'c0', citationItems: [{ id: 'smith19' }], properties: { noteIndex: 0 } }
    ]
    const rendered = await withEngine('chicago-author-date', [SMITH], (engine) =>
      engine.rebuildProcessorState(clusters, 'text')
    )
    expect(rendered[0]?.[2]).toBe('(Smith 2019)')
  })

  it('shortens a repeated citation once it has seen both in document order', async () => {
    const clusters: CitationCluster[] = [
      { citationID: 'c0', citationItems: [{ id: 'smith19' }], properties: { noteIndex: 1 } },
      { citationID: 'c1', citationItems: [{ id: 'smith19' }], properties: { noteIndex: 2 } }
    ]
    const rendered = await withEngine('chicago-notes-bibliography', [SMITH], (engine) =>
      engine.rebuildProcessorState(clusters, 'text')
    )
    const [, , first] = rendered[0]!
    const [, , second] = rendered[1]!
    expect(first).toContain('2019')
    // The second reference to the same work shortens — this is the case a
    // per-citation, order-blind renderer cannot produce.
    expect(second).not.toBe(first)
    expect(second.length).toBeLessThan(first.length)
  })

  it('drops a source no longer cited from the registry, so it cannot leak into a later bibliography', async () => {
    await withEngine('chicago-author-date', [SMITH, DIAZ], (engine) => engine.updateItems(['smith19', 'diaz21']))
    const bibWithBoth = await withEngine('chicago-author-date', [SMITH, DIAZ], (engine) => {
      engine.setOutputFormat('text')
      return engine.makeBibliography()
    })
    expect(bibWithBoth && bibWithBoth[1]).toHaveLength(2)

    const bibWithOne = await withEngine('chicago-author-date', [SMITH], (engine) => {
      engine.setOutputFormat('text')
      return engine.makeBibliography()
    })
    expect(bibWithOne && bibWithOne[1]).toHaveLength(1)
  })
})
