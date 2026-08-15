import { useCallback, useEffect, useMemo, useState } from 'react'
import type { VfsEntry } from '@shared/model/vfs.js'
import { DOC_EXT, IGNORED_DIRS } from '@shared/constants.js'
import { validateFileName } from '@shared/model/filename.js'
import { invoke, attempt, on, reportError } from '@renderer/lib/ipc.js'
import { useProjectStore } from '@renderer/stores/projectStore.js'
import { useDocumentStore } from '@renderer/stores/documentStore.js'
import { useLayoutStore } from '@renderer/stores/layoutStore.js'
import { PanelShell, PanelHeader, EmptyState, ToolbarButton, cx } from '@renderer/ui/primitives.js'

interface TreeNode extends VfsEntry {
  depth: number
}

const IGNORED = new Set(IGNORED_DIRS)

/**
 * Project file tree.
 *
 * Directories are listed on demand rather than walked up front, so opening a
 * project with a deep folder structure — or one on a slow remote backend — is
 * immediate.
 */
export function FileTree() {
  const project = useProjectStore((store) => store.project)
  const openPath = useDocumentStore((store) => store.openPath)
  const openEditor = useLayoutStore((store) => store.openEditor)
  const [children, setChildren] = useState<Record<string, VfsEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']))
  const [selected, setSelected] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [creating, setCreating] = useState<{ parent: string; kind: 'file' | 'dir' } | null>(null)

  const loadDirectory = useCallback(async (path: string) => {
    const entries = await invoke('vfs:list', { path }).catch(() => null)
    if (!entries) return
    setChildren((current) => ({
      ...current,
      [path]: entries.filter((entry) => !(entry.kind === 'dir' && IGNORED.has(entry.name)))
    }))
  }, [])

  useEffect(() => {
    if (!project) return
    setChildren({})
    setExpanded(new Set(['']))
    void loadDirectory('')
  }, [project, loadDirectory])

  // Keep the tree honest about what is actually on disk, including changes made
  // by other apps or a sync client.
  useEffect(() => {
    return on('vfs:changed', (events) => {
      const dirty = new Set<string>()
      for (const event of events) {
        const slash = event.path.lastIndexOf('/')
        dirty.add(slash === -1 ? '' : event.path.slice(0, slash))
      }
      for (const directory of dirty) {
        if (children[directory] !== undefined) void loadDirectory(directory)
      }
    })
  }, [children, loadDirectory])

  const toggle = useCallback(
    (entry: VfsEntry) => {
      setExpanded((current) => {
        const next = new Set(current)
        if (next.has(entry.path)) next.delete(entry.path)
        else {
          next.add(entry.path)
          if (children[entry.path] === undefined) void loadDirectory(entry.path)
        }
        return next
      })
    },
    [children, loadDirectory]
  )

  const rows = useMemo(() => flatten('', children, expanded, 0), [children, expanded])

  const openDocument = useCallback(
    async (entry: VfsEntry) => {
      const docId = await openPath(entry.path)
      if (docId) {
        const state = useDocumentStore.getState().docs[docId]
        openEditor(docId, entry.path, state?.title ?? entry.name)
      }
    },
    [openPath, openEditor]
  )

  const commitRename = useCallback(
    async (entry: VfsEntry, name: string) => {
      setRenaming(null)
      const trimmed = name.trim()
      if (!trimmed || trimmed === entry.name) return
      if (!nameIsUsable(trimmed)) return
      const parent = entry.path.slice(0, Math.max(0, entry.path.lastIndexOf('/')))
      const target = parent ? `${parent}/${trimmed}` : trimmed
      const done = await attempt(invoke('vfs:rename', { from: entry.path, to: target }), 'Could not rename')
      if (done) {
        useDocumentStore.getState().renamePath(entry.path, target)
        void loadDirectory(parent)
      }
    },
    [loadDirectory]
  )

  const commitCreate = useCallback(
    async (name: string) => {
      const request = creating
      setCreating(null)
      const trimmed = name.trim()
      if (!request || !trimmed) return
      if (!nameIsUsable(trimmed)) return
      const target = request.parent ? `${request.parent}/${trimmed}` : trimmed
      if (request.kind === 'dir') {
        await attempt(invoke('vfs:mkdir', { path: target }), 'Could not create folder')
      } else {
        const docId = await useDocumentStore.getState().create(target)
        if (docId) {
          const state = useDocumentStore.getState().docs[docId]
          if (state) openEditor(docId, state.path, state.title)
        }
      }
      void loadDirectory(request.parent)
    },
    [creating, loadDirectory, openEditor]
  )

  const remove = useCallback(
    async (entry: VfsEntry) => {
      const done = await attempt(
        invoke('vfs:delete', { path: entry.path, recursive: entry.kind === 'dir' }),
        'Could not delete'
      )
      if (done) {
        const parent = entry.path.slice(0, Math.max(0, entry.path.lastIndexOf('/')))
        void loadDirectory(parent)
      }
    },
    [loadDirectory]
  )

  if (!project) {
    return (
      <PanelShell>
        <PanelHeader>Explorer</PanelHeader>
        <EmptyState title="No project open" hint="Open a folder to start writing." />
      </PanelShell>
    )
  }

  const newFileParent = selected ? parentOf(selected, children) : ''

  return (
    <PanelShell>
      <PanelHeader>
        <span className="flex-1 truncate normal-case" title={project.root}>
          {project.manifest.name}
        </span>
        <ToolbarButton
          label="New document"
          onClick={() => {
            setCreating({ parent: newFileParent, kind: 'file' })
            setDraft(`untitled${DOC_EXT}`)
          }}
        >
          ＋
        </ToolbarButton>
        <ToolbarButton
          label="New folder"
          onClick={() => {
            setCreating({ parent: newFileParent, kind: 'dir' })
            setDraft('new-folder')
          }}
        >
          ⊞
        </ToolbarButton>
      </PanelHeader>

      <div className="flex-1 overflow-auto py-1">
        {creating && creating.parent === '' ? (
          <NameInput
            depth={0}
            value={draft}
            onChange={setDraft}
            onCommit={commitCreate}
            onCancel={() => setCreating(null)}
          />
        ) : null}

        {rows.map((node) => {
          const isRenaming = renaming === node.path
          return (
            <div key={node.path}>
              {isRenaming ? (
                <NameInput
                  depth={node.depth}
                  value={draft}
                  onChange={setDraft}
                  onCommit={(name) => void commitRename(node, name)}
                  onCancel={() => setRenaming(null)}
                />
              ) : (
                <TreeRow
                  node={node}
                  expanded={expanded.has(node.path)}
                  selected={selected === node.path}
                  onSelect={() => setSelected(node.path)}
                  onActivate={() => {
                    if (node.kind === 'dir') toggle(node)
                    else void openDocument(node)
                  }}
                  onRename={() => {
                    setRenaming(node.path)
                    setDraft(node.name)
                  }}
                  onDelete={() => void remove(node)}
                  onReveal={() => void invoke('vfs:revealInOs', { path: node.path })}
                />
              )}
              {creating && creating.parent === node.path ? (
                <NameInput
                  depth={node.depth + 1}
                  value={draft}
                  onChange={setDraft}
                  onCommit={commitCreate}
                  onCancel={() => setCreating(null)}
                />
              ) : null}
            </div>
          )
        })}
      </div>
    </PanelShell>
  )
}

function TreeRow({
  node,
  expanded,
  selected,
  onSelect,
  onActivate,
  onRename,
  onDelete,
  onReveal
}: {
  node: TreeNode
  expanded: boolean
  selected: boolean
  onSelect: () => void
  onActivate: () => void
  onRename: () => void
  onDelete: () => void
  onReveal: () => void
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const isDocument = node.kind === 'file' && node.path.endsWith(DOC_EXT)

  return (
    <>
      <div
        role="treeitem"
        aria-expanded={node.kind === 'dir' ? expanded : undefined}
        aria-selected={selected}
        tabIndex={0}
        onClick={() => {
          onSelect()
          onActivate()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onActivate()
          if (event.key === 'F2') onRename()
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          onSelect()
          setMenu({ x: event.clientX, y: event.clientY })
        }}
        style={{ paddingLeft: 6 + node.depth * 12 }}
        className={cx(
          'pub-focus-ring flex h-[22px] cursor-default select-none items-center gap-1 pr-2 text-[12px]',
          selected ? 'bg-surface-3 text-text' : 'text-muted hover:bg-surface-2'
        )}
      >
        <span className="w-3 shrink-0 text-center text-[9px] text-faint">
          {node.kind === 'dir' ? (expanded ? '▾' : '▸') : ''}
        </span>
        <span className={cx('truncate', isDocument && 'text-text')}>{node.name}</span>
      </div>
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: 'Rename', run: onRename },
            { label: 'Reveal in File Manager', run: onReveal },
            { label: 'Move to Trash', run: onDelete, danger: true }
          ]}
        />
      ) : null}
    </>
  )
}

function NameInput({
  depth,
  value,
  onChange,
  onCommit,
  onCancel
}: {
  depth: number
  value: string
  onChange: (value: string) => void
  onCommit: (value: string) => void
  onCancel: () => void
}) {
  return (
    <div style={{ paddingLeft: 6 + depth * 12 }} className="flex h-[22px] items-center pr-2">
      <input
        autoFocus
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => onCommit(value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onCommit(value)
          if (event.key === 'Escape') onCancel()
        }}
        className="h-[20px] w-full rounded-sm border border-accent bg-surface-2 px-1 text-[12px] text-text outline-none"
      />
    </div>
  )
}

function ContextMenu({
  x,
  y,
  items,
  onClose
}: {
  x: number
  y: number
  items: { label: string; run: () => void; danger?: boolean }[]
  onClose: () => void
}) {
  useEffect(() => {
    const dismiss = (): void => onClose()
    window.addEventListener('click', dismiss)
    window.addEventListener('contextmenu', dismiss)
    return () => {
      window.removeEventListener('click', dismiss)
      window.removeEventListener('contextmenu', dismiss)
    }
  }, [onClose])

  return (
    <div
      style={{ left: x, top: y }}
      className="fixed z-50 min-w-40 rounded border border-border bg-surface-2 py-1 shadow-lg"
      onClick={(event) => event.stopPropagation()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          onClick={() => {
            onClose()
            item.run()
          }}
          className={cx(
            'block w-full px-3 py-1 text-left text-[12px] hover:bg-surface-3',
            item.danger ? 'text-danger' : 'text-text'
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

function flatten(
  directory: string,
  children: Record<string, VfsEntry[]>,
  expanded: Set<string>,
  depth: number
): TreeNode[] {
  const entries = children[directory]
  if (!entries) return []
  const rows: TreeNode[] = []
  for (const entry of entries) {
    rows.push({ ...entry, depth })
    if (entry.kind === 'dir' && expanded.has(entry.path)) {
      rows.push(...flatten(entry.path, children, expanded, depth + 1))
    }
  }
  return rows
}

/**
 * Refuse an unusable name here as well as in main.
 *
 * Main checks it too — that is the boundary that matters — but this runs before
 * the round trip, so the author is told the moment they press Enter rather than
 * after a file operation has been attempted on their behalf.
 */
function nameIsUsable(name: string): boolean {
  const result = validateFileName(name)
  if (result.ok) return true
  reportError(result.reason)
  return false
}

/** New items are created inside the selected folder, or beside the selected file. */
function parentOf(path: string, children: Record<string, VfsEntry[]>): string {
  if (children[path] !== undefined) return path
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}
