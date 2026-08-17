import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { VfsEntry } from '@shared/model/vfs.js'
import { DOC_EXT, IGNORED_DIRS } from '@shared/constants.js'
import { validateFileName } from '@shared/model/filename.js'
import { invoke, attempt, on } from '@renderer/lib/ipc.js'
import { useProjectStore } from '@renderer/stores/projectStore.js'
import { useDocumentStore } from '@renderer/stores/documentStore.js'
import { useLayoutStore } from '@renderer/stores/layoutStore.js'
import { PanelShell, PanelHeader, EmptyState, ToolbarButton, cx } from '@renderer/ui/primitives.js'
import { ContextMenu } from '@renderer/ui/Menu.js'
import { registerCommand } from '@renderer/commands/registry.js'
import { flatten, parentFor, findEntry, ancestorsOf, type TreeNode } from './tree.js'

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
  const [draftProblem, setDraftProblem] = useState<string | null>(null)
  const [creating, setCreating] = useState<{ parent: string; kind: 'file' | 'dir' } | null>(null)
  const [backgroundMenu, setBackgroundMenu] = useState<{ x: number; y: number } | null>(null)
  const treeRef = useRef<HTMLDivElement>(null)

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
    // Selection and half-typed names belong to the previous project; keeping
    // them would aim the next create at a folder that no longer exists here.
    setSelected(null)
    setRenaming(null)
    setCreating(null)
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

  /**
   * Open the inline name input under a parent directory.
   *
   * The input renders under the parent's row, so the parent has to be on
   * screen: expand every ancestor and load any listing not yet fetched first.
   * Without this, creating under a collapsed branch set state that rendered
   * nowhere — the click looked like it did nothing, which is exactly the class
   * of bug this panel is being cured of.
   */
  const beginCreate = useCallback(
    async (parent: string, kind: 'file' | 'dir') => {
      const line = [...ancestorsOf(parent), ...(parent ? [parent] : [])]
      setExpanded((current) => new Set([...current, ...line]))
      for (const directory of line) {
        if (children[directory] === undefined) await loadDirectory(directory)
      }
      setCreating({ parent, kind })
      setDraft(kind === 'dir' ? 'new-folder' : `untitled${DOC_EXT}`)
      setDraftProblem(null)
    },
    [children, loadDirectory]
  )

  /** Where the toolbar buttons and app-level commands create. */
  const defaultParent = useCallback((): string => {
    if (!selected) return ''
    const entry = findEntry(selected, children)
    return entry ? parentFor(entry.path, entry.kind) : ''
  }, [selected, children])

  /*
   * The Explorer claims `document.new` and `folder.new` while it is on screen:
   * its inline input beats the app-level dialog because the name is typed where
   * the file will appear. The menu item, the shortcut, the palette and the ＋
   * button all dispatch the same command, so they cannot drift apart.
   *
   * "On screen" rather than "mounted", and that distinction is load-bearing.
   * Dockview keeps a stacked panel mounted when another tab in its group is
   * active — the Explorer shares a group with Search — so a merely-mounted
   * test would let a hidden Explorer swallow Ctrl+N and render its input where
   * nobody can see it. Which is the exact failure this whole change exists to
   * remove.
   */
  // `checkVisibility` rather than a box measurement: dockview hides an inactive
  // tab's panel with `visibility: hidden`, which still lays out and still
  // reports client rects, so anything geometric answers "yes" for a panel
  // nobody can see.
  const onScreen = useCallback(
    (): boolean => treeRef.current?.checkVisibility({ visibilityProperty: true }) ?? false,
    []
  )

  useEffect(() => {
    if (!project) return
    const unregister = [
      registerCommand({
        id: 'document.new',
        title: 'New Document',
        priority: 1,
        isEnabled: onScreen,
        run: () => void beginCreate(defaultParent(), 'file')
      }),
      registerCommand({
        id: 'folder.new',
        title: 'New Folder',
        priority: 1,
        isEnabled: onScreen,
        run: () => void beginCreate(defaultParent(), 'dir')
      })
    ]
    return () => unregister.forEach((dispose) => dispose())
  }, [project, beginCreate, defaultParent, onScreen])

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
      const trimmed = name.trim()
      if (!trimmed || trimmed === entry.name) {
        setRenaming(null)
        return
      }
      // An unusable name keeps the input open with the reason beside it, so
      // the typing survives to be corrected rather than vanishing with a toast.
      const checked = validateFileName(trimmed)
      if (!checked.ok) {
        setDraftProblem(checked.reason)
        return
      }
      setRenaming(null)
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
      const trimmed = name.trim()
      if (!request || !trimmed) {
        setCreating(null)
        return
      }
      const checked = validateFileName(trimmed)
      if (!checked.ok) {
        setDraftProblem(checked.reason)
        return
      }
      setCreating(null)
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

  const nameInput = (depth: number, onCommit: (name: string) => void, onCancel: () => void) => (
    <NameInput
      depth={depth}
      value={draft}
      problem={draftProblem}
      onChange={(value) => {
        setDraft(value)
        setDraftProblem(null)
      }}
      onCommit={onCommit}
      onCancel={onCancel}
    />
  )

  return (
    <PanelShell>
      <PanelHeader>
        <span className="flex-1 truncate normal-case" title={project.root}>
          {project.manifest.name}
        </span>
        <ToolbarButton label="New document" onClick={() => void beginCreate(defaultParent(), 'file')}>
          ＋
        </ToolbarButton>
        <ToolbarButton label="New folder" onClick={() => void beginCreate(defaultParent(), 'dir')}>
          ⊞
        </ToolbarButton>
      </PanelHeader>

      <div
        ref={treeRef}
        role="tree"
        aria-label={`${project.manifest.name} files`}
        className="flex-1 overflow-auto py-1"
        data-testid="file-tree"
        onContextMenu={(event) => {
          // Rows call stopPropagation, so reaching here means empty space:
          // offer creation at the project root.
          event.preventDefault()
          // And this menu must stop it too. The menu dismisses itself on any
          // contextmenu reaching the window, and without this the very event
          // that opened it would arrive there and close it again.
          event.stopPropagation()
          setBackgroundMenu({ x: event.clientX, y: event.clientY })
        }}
      >
        {creating && creating.parent === ''
          ? nameInput(0, commitCreate, () => setCreating(null))
          : null}

        {rows.map((node) => {
          const isRenaming = renaming === node.path
          return (
            <div key={node.path}>
              {isRenaming ? (
                nameInput(node.depth, (name) => void commitRename(node, name), () => setRenaming(null))
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
                  onCreate={(kind) => void beginCreate(parentFor(node.path, node.kind), kind)}
                  onRename={() => {
                    setRenaming(node.path)
                    setDraft(node.name)
                    setDraftProblem(null)
                  }}
                  onDelete={() => void remove(node)}
                  isLocal={project.isLocal}
                  onReveal={() => void invoke('vfs:revealInOs', { path: node.path })}
                />
              )}
              {creating && creating.parent === node.path
                ? nameInput(node.depth + 1, commitCreate, () => setCreating(null))
                : null}
            </div>
          )
        })}
      </div>

      {backgroundMenu ? (
        <ContextMenu
          x={backgroundMenu.x}
          y={backgroundMenu.y}
          onClose={() => setBackgroundMenu(null)}
          items={[
            { label: 'New Document', run: () => void beginCreate('', 'file') },
            { label: 'New Folder', run: () => void beginCreate('', 'dir') },
            ...(project.isLocal
              ? [
                  { separator: true as const },
                  {
                    label: 'Reveal in File Manager',
                    run: () => void invoke('vfs:revealInOs', { path: '' })
                  }
                ]
              : [])
          ]}
        />
      ) : null}
    </PanelShell>
  )
}

function TreeRow({
  node,
  expanded,
  selected,
  onSelect,
  onActivate,
  onCreate,
  onRename,
  onDelete,
  isLocal,
  onReveal
}: {
  node: TreeNode
  expanded: boolean
  selected: boolean
  onSelect: () => void
  onActivate: () => void
  onCreate: (kind: 'file' | 'dir') => void
  onRename: () => void
  onDelete: () => void
  /** A project on a server has no folder to reveal and no trash to delete into. */
  isLocal: boolean
  onReveal: () => void
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const isDocument = node.kind === 'file' && node.path.endsWith(DOC_EXT)

  return (
    <>
      <div
        role="treeitem"
        // Named explicitly, or the chevron glyph joins the text and the row
        // announces itself as "▸ chapter-one" to a screen reader.
        aria-label={node.name}
        aria-expanded={node.kind === 'dir' ? expanded : undefined}
        aria-selected={selected}
        aria-level={node.depth + 1}
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
          // Without this the tree's own background menu opens on top of ours.
          event.stopPropagation()
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
            { label: 'New Document', run: () => onCreate('file') },
            { label: 'New Folder', run: () => onCreate('dir') },
            { separator: true },
            { label: 'Rename', run: onRename },
            // Nothing to reveal when the file is on a server.
            ...(isLocal ? [{ label: 'Reveal in File Manager', run: onReveal }] : []),
            { separator: true },
            // Named for what it does. There is no trash on a server, so the
            // delete is permanent — and an author who expects to find the
            // chapter in a wastebasket that was never involved is one who
            // learns the difference too late.
            { label: isLocal ? 'Move to Trash' : 'Delete', run: onDelete, danger: true }
          ]}
        />
      ) : null}
    </>
  )
}

function NameInput({
  depth,
  value,
  problem,
  onChange,
  onCommit,
  onCancel
}: {
  depth: number
  value: string
  problem: string | null
  onChange: (value: string) => void
  onCommit: (value: string) => void
  onCancel: () => void
}) {
  return (
    <div style={{ paddingLeft: 6 + depth * 12 }} className="pr-2">
      <div className="flex h-[22px] items-center">
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
      {problem ? (
        <p data-testid="name-problem" className="px-1 py-0.5 text-[11px] text-danger">
          {problem}
        </p>
      ) : null}
    </div>
  )
}
