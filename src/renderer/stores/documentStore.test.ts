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
