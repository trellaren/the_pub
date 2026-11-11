import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PubDocument, PmDoc } from '@shared/model/document.js'

const invoke = vi.fn()
vi.mock('@renderer/lib/ipc.js', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  attempt: async <T>(operation: Promise<T>) => operation.catch(() => null),
  reportError: vi.fn(),
  errorMessage: (error: unknown) => String(error),
  on: () => () => {}
}))
vi.mock('@renderer/panels/editor/createEditor.js', () => ({
  createEditor: (options: { content: PmDoc }) => {
    let content = options.content
    return {
      getJSON: () => content,
      commands: { setContent: (next: PmDoc) => (content = next) },
      destroy: vi.fn()
    }
  }
}))
vi.mock('@renderer/panels/editor/editorActions.js', () => ({ setSuggesting: () => {} }))
vi.mock('./statsStore.js', () => ({ useStatsStore: { getState: () => ({ recordChange: async () => {} }) } }))
vi.mock('./appStore.js', () => ({ useAppStore: { getState: () => ({ load: async () => {} }) } }))

const { useDocumentStore, getEditor } = await import('./documentStore.js')
const { useProjectStore } = await import('./projectStore.js')

function envelope(docId: string): PubDocument {
  return {
    docId,
    title: 'Draft',
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] }
  } as unknown as PubDocument
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

const project = { uri: '/novel', root: '/novel', readOnly: false, manifest: { settings: {}, publication: {} } }

beforeEach(() => {
  invoke.mockReset()
  useDocumentStore.setState(useDocumentStore.getInitialState(), true)
  useProjectStore.setState({ project: project as never })
})

async function openDoc(docId: string, path: string): Promise<void> {
  invoke.mockImplementationOnce(async () => ({ doc: envelope(docId), path, mtime: 1 }))
  await useDocumentStore.getState().openPath(path)
}

function editDoc(docId: string, changes: Record<string, unknown>): void {
  const docs = useDocumentStore.getState().docs
  useDocumentStore.setState({ docs: { ...docs, [docId]: { ...docs[docId]!, ...changes } } })
}

describe('documentStore.save', () => {
  it('keeps a retitle made while the write was in flight', async () => {
    await openDoc('d1', 'a.pub')
    const write = deferred<{ ok: true; mtime: number }>()
    invoke.mockImplementation((channel: string) => (channel === 'doc:write' ? write.promise : Promise.resolve(null)))
    const saving = useDocumentStore.getState().save('d1')
    const before = useDocumentStore.getState().docs.d1!
    editDoc('d1', { title: 'Renamed', envelope: { ...before.envelope, title: 'Renamed' } })
    write.resolve({ ok: true, mtime: 2 })
    await saving
    const state = useDocumentStore.getState().docs.d1!
    expect(state.envelope.title).toBe('Renamed')
    expect(state.envelope.content).toEqual(envelope('d1').content)
    expect(state.mtime).toBe(2)
    expect(getEditor('d1')).toBeDefined()
  })

  it('does not write once the project is gone', async () => {
    await openDoc('d1', 'a.pub')
    useProjectStore.setState({ project: null })
    await useDocumentStore.getState().save('d1')
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})

describe('documentStore.renamePath', () => {
  it('moves open documents inside a renamed folder, and only those', async () => {
    await openDoc('d1', 'part1/ch1.pub')
    await openDoc('d2', 'part1/sub/ch2.pub')
    await openDoc('d3', 'part10/ch3.pub')
    await openDoc('d4', 'part1.pub')
    useDocumentStore.getState().renamePath('part1', 'act1')
    const docs = useDocumentStore.getState().docs
    expect(docs.d1!.path).toBe('act1/ch1.pub')
    expect(docs.d2!.path).toBe('act1/sub/ch2.pub')
    expect(docs.d3!.path).toBe('part10/ch3.pub')
    expect(docs.d4!.path).toBe('part1.pub')
  })

  it('still renames a single file', async () => {
    await openDoc('d1', 'a.pub')
    useDocumentStore.getState().renamePath('a.pub', 'b.pub')
    expect(useDocumentStore.getState().docs.d1!.path).toBe('b.pub')
  })
})

describe('documentStore open', () => {
  it('shares one editor between two concurrent opens of the same path', async () => {
    const read = deferred<unknown>()
    invoke.mockImplementation(() => read.promise)
    const first = useDocumentStore.getState().openPath('a.pub')
    const second = useDocumentStore.getState().openPath('a.pub')
    read.resolve({ doc: envelope('d1'), path: 'a.pub', mtime: 1 })
    expect(await first).toBe('d1')
    expect(await second).toBe('d1')
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('does not replace the editor when the same document arrives by path and by id', async () => {
    const read = deferred<unknown>()
    invoke.mockImplementation((channel: string) =>
      channel === 'doc:resolve' ? Promise.resolve({ path: 'a.pub' }) : read.promise
    )
    const byPath = useDocumentStore.getState().openPath('a.pub')
    const byId = useDocumentStore.getState().openDocId('d1')
    read.resolve({ doc: envelope('d1'), path: 'a.pub', mtime: 1 })
    await byPath
    const editor = getEditor('d1')
    await byId
    expect(getEditor('d1')).toBe(editor)
  })

  it('opens read-only when the read says a newer build wrote the file', async () => {
    invoke.mockImplementationOnce(async () => ({ doc: envelope('d1'), path: 'a.pub', mtime: 1, tooNew: true }))
    await useDocumentStore.getState().openPath('a.pub')
    expect(useDocumentStore.getState().docs.d1!.tooNew).toBe(true)
  })

  it('treats a conflict against mtime 0 as the missing-file state', async () => {
    await openDoc('d1', 'a.pub')
    invoke.mockImplementation(async () => ({ ok: false, reason: 'conflict', diskMtime: 0 }))
    await useDocumentStore.getState().save('d1')
    const state = useDocumentStore.getState().docs.d1!
    expect([state.missing, state.conflict, state.dirty]).toEqual([true, false, true])
  })

  it('treats a write to a deleted file as the missing-file state', async () => {
    await openDoc('d1', 'a.pub')
    invoke.mockImplementation(async () => ({ ok: false, reason: 'missing' }))
    await useDocumentStore.getState().save('d1')
    const state = useDocumentStore.getState().docs.d1!
    expect(state.missing).toBe(true)
    expect(state.dirty).toBe(true)
    expect(state.tooNew).toBe(false)
  })
})

describe('documentStore.discardAll', () => {
  it('destroys every editor and forgets every document', async () => {
    await openDoc('d1', 'a.pub')
    const editor = getEditor('d1')!
    useDocumentStore.getState().discardAll()
    expect(editor.destroy).toHaveBeenCalled()
    expect(getEditor('d1')).toBeUndefined()
    expect(useDocumentStore.getState().docs).toEqual({})
  })
})
