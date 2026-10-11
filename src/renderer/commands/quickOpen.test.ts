import { describe, expect, it } from 'vitest'
import { matchDocuments } from './quickOpen.js'

const docs = [
  { docId: '1', title: 'The Storm', path: 'act-2/storm.pubdoc' },
  { docId: '2', title: 'Arrival', path: 'act-1/arrival.pubdoc' },
  { docId: '3', title: 'Aftermath', path: 'act-2/storm-aftermath.pubdoc' }
]

describe('matchDocuments', () => {
  it('lists everything, by path, for an empty query', () => {
    expect(matchDocuments(docs, '').map((doc) => doc.docId)).toEqual(['2', '3', '1'])
  })

  it('matches titles ahead of paths', () => {
    expect(matchDocuments(docs, 'storm').map((doc) => doc.docId)).toEqual(['1', '3'])
  })

  it('needs every word, from title or path', () => {
    expect(matchDocuments(docs, 'act-2 after').map((doc) => doc.docId)).toEqual(['3'])
    expect(matchDocuments(docs, 'nothing here')).toEqual([])
  })

  it('ignores case', () => {
    expect(matchDocuments(docs, 'ARRIVAL').map((doc) => doc.docId)).toEqual(['2'])
  })
})
