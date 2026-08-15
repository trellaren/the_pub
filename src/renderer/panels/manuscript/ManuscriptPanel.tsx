import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react'
import { isPart, type ManuscriptNode, type PartRole, type ResolvedNode } from '@shared/model/manuscript.js'
import { useProjectStore } from '@renderer/stores/projectStore.js'
import { useManuscriptStore } from '@renderer/stores/manuscriptStore.js'
import { useLayoutStore } from '@renderer/stores/layoutStore.js'
import { useDocumentStore } from '@renderer/stores/documentStore.js'
import { PanelShell, PanelHeader, EmptyState, ToolbarButton } from '@renderer/ui/primitives.js'
import { promptForName } from '@renderer/ui/PromptDialog.js'
import { ContextMenu, type MenuEntry } from '@renderer/ui/Menu.js'
import { DocumentPicker } from './DocumentPicker.js'
import { ManuscriptNodeRow, ManuscriptPlaceholderRow } from './ManuscriptRow.js'
import { dropRows, resolveDrop, resolveMove, type DropTarget, type Move } from './dropTarget.js'

const MIME = 'text/pub-manuscript-node'

/**
 * The book, laid out as parts and chapters and reordered by dragging or by the
 * four move buttons every row carries. A separate panel from the Explorer on
 * purpose — order here is a real, author-set property, where the file tree's
 * order is just whatever the filesystem returns.
 */
export function ManuscriptPanel() {
  const project = useProjectStore((store) => store.project)
  const view = useManuscriptStore((store) => store.view)
  const loaded = useManuscriptStore((store) => store.loaded)
  const collapsed = useManuscriptStore((store) => store.collapsed)
  const toggleCollapsed = useManuscriptStore((store) => store.toggleCollapsed)
  const createPart = useManuscriptStore((store) => store.createPart)
  const addDocuments = useManuscriptStore((store) => store.addDocuments)
  const move = useManuscriptStore((store) => store.move)
  const rename = useManuscriptStore((store) => store.rename)
  const setRole = useManuscriptStore((store) => store.setRole)
  const relink = useManuscriptStore((store) => store.relink)
  const remove = useManuscriptStore((store) => store.remove)

  const [selected, setSelected] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [target, setTarget] = useState<DropTarget | null>(null)
  const [picker, setPicker] = useState<{ mode: 'add' | 'relink'; parentId: string | null; nodeId: string | null } | null>(
    null
  )
  const [menu, setMenu] = useState<{ x: number; y: number; node: ManuscriptNode } | null>(null)

  useEffect(() => {
    if (!project) return
    void useManuscriptStore.getState().load()
  }, [project?.root])

  const rows = useMemo(() => dropRows(view.nodes, collapsed), [view.nodes, collapsed])
  const resolved = useMemo(() => new Map(view.nodes.map((node) => [node.id, node])), [view.nodes])

  const aim = useCallback(
    (event: DragEvent, rowIndex: number) => {
      if (!dragging) return
      event.preventDefault()
      const rect = event.currentTarget.getBoundingClientRect()
      const fraction = (event.clientY - rect.top) / rect.height
      setTarget(resolveDrop(view.nodes, rows, dragging, rowIndex, fraction))
    },
    [dragging, rows, view.nodes]
  )

  const commitDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault()
      if (dragging && target) void move(dragging, target.parentId, target.index)
      setDragging(null)
      setTarget(null)
    },
    [dragging, target, move]
  )

  const endDrag = useCallback(() => {
    setDragging(null)
    setTarget(null)
  }, [])

  const openDocument = useCallback(
    async (node: ResolvedNode) => {
      if (node.missing || !node.resolvedPath) return
      const docId = await useDocumentStore.getState().openPath(node.resolvedPath)
      if (docId) {
        const state = useDocumentStore.getState().docs[docId]
        useLayoutStore.getState().openEditor(docId, node.resolvedPath, state?.title ?? node.title)
      }
    },
    []
  )

  const addPart = useCallback(
    async (owner?: Document) => {
      const title = await promptForName({ title: 'New part', ownerDocument: owner })
      if (title) void createPart(title)
    },
    [createPart]
  )

  const renameNode = useCallback(
    async (id: string, current: string, owner?: Document) => {
      const title = await promptForName({
        title: 'Rename',
        defaultValue: current,
        confirmLabel: 'Rename',
        ownerDocument: owner
      })
      if (title && title !== current) void rename(id, title)
    },
    [rename]
  )

  const removeNode = useCallback(
    (node: ManuscriptNode) => {
      if (isPart(node)) {
        const hasChildren = view.nodes.some((candidate) => candidate.parentId === node.id)
        if (hasChildren && !window.confirm('Remove this part? Its chapters move to the top level.')) return
      }
      void remove(node.id)
      if (selected === node.id) setSelected(null)
    },
    [remove, selected, view.nodes]
  )

  const canMove = useCallback(
    (id: string, kind: Move) => resolveMove(view.nodes, id, kind) !== null,
    [view.nodes]
  )
  const doMove = useCallback(
    (id: string, kind: Move) => {
      const destination = resolveMove(view.nodes, id, kind)
      if (destination) void move(id, destination.parentId, destination.index)
    },
    [move, view.nodes]
  )

  if (!project) {
    return (
      <PanelShell>
        <PanelHeader>Manuscript</PanelHeader>
        <EmptyState title="No project open" />
      </PanelShell>
    )
  }

  const wordTotal = view.nodes
    .filter((node) => node.parentId === null)
    .reduce((sum, node) => sum + (resolved.get(node.id)?.words ?? 0), 0)

  return (
    <PanelShell>
      <PanelHeader>
        <span className="flex-1">Manuscript</span>
        <span className="shrink-0 text-[10px] normal-case text-faint">{wordTotal.toLocaleString()} words</span>
        <ToolbarButton label="Add part" onClick={(event) => void addPart(event.currentTarget.ownerDocument)}>
          ＋ part
        </ToolbarButton>
        <ToolbarButton
          label="Add documents"
          onClick={() => setPicker({ mode: 'add', parentId: null, nodeId: null })}
        >
          ＋ chapter
        </ToolbarButton>
      </PanelHeader>

      {loaded && rows.length === 0 ? (
        <EmptyState
          title="The book is empty"
          hint="Add a part or a document to start building the manuscript."
        />
      ) : (
        <div role="tree" data-testid="manuscript-tree" className="flex flex-1 flex-col overflow-auto py-1">
          {rows.map((row, index) => {
            const between =
              target?.indicator.kind === 'between' && target.indicator.row === index ? target.indicator.depth : null
            const rowElement =
              row.kind === 'placeholder' ? (
                <ManuscriptPlaceholderRow
                  key={`placeholder-${row.partId}`}
                  insideTarget={target?.indicator.kind === 'inside' && target.indicator.partId === row.partId}
                  onDragOver={(event) => aim(event, index)}
                  onDrop={commitDrop}
                />
              ) : (
                <ManuscriptNodeRow
                  key={row.node.id}
                  node={resolved.get(row.node.id) ?? asResolved(row.node)}
                  depth={row.depth}
                  expanded={!collapsed.has(row.node.id)}
                  selected={selected === row.node.id}
                  dragging={dragging === row.node.id}
                  insideTarget={target?.indicator.kind === 'inside' && target.indicator.partId === row.node.id}
                  words={resolved.get(row.node.id)?.words ?? 0}
                  missing={resolved.get(row.node.id)?.missing ?? false}
                  onToggle={() => toggleCollapsed(row.node.id)}
                  onSelect={() => setSelected(row.node.id)}
                  onActivate={() => {
                    const data = resolved.get(row.node.id)
                    if (data) void openDocument(data)
                  }}
                  onRename={(title, owner) => void renameNode(row.node.id, title, owner)}
                  onSetRole={(role: PartRole) => void setRole(row.node.id, role)}
                  onAddInto={() => setPicker({ mode: 'add', parentId: row.node.id, nodeId: null })}
                  onRelink={() => setPicker({ mode: 'relink', parentId: null, nodeId: row.node.id })}
                  onRemove={() => removeNode(row.node)}
                  onMove={(kind) => doMove(row.node.id, kind)}
                  canMove={(kind) => canMove(row.node.id, kind)}
                  onDragStart={(event) => {
                    event.dataTransfer.setData(MIME, row.node.id)
                    event.dataTransfer.effectAllowed = 'move'
                    setDragging(row.node.id)
                  }}
                  onDragOver={(event) => aim(event, index)}
                  onDrop={commitDrop}
                  onDragEnd={endDrag}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    setSelected(row.node.id)
                    setMenu({ x: event.clientX, y: event.clientY, node: row.node })
                  }}
                />
              )
            return (
              <div key={row.kind === 'placeholder' ? `ph-${row.partId}` : row.node.id} className="relative">
                {between !== null ? <DropRule depth={between} /> : null}
                {rowElement}
              </div>
            )
          })}
          {/* A drop target past the last row, so something can be sent to the end of
              the book. Keeps its handlers whether or not the rule is currently
              showing — losing them the moment the rule appears would mean a drop
              aimed at the very target being displayed does nothing. */}
          <div
            className="relative h-4 min-h-4 flex-1"
            onDragOver={(event) => aim(event, rows.length)}
            onDrop={commitDrop}
          >
            {target?.indicator.kind === 'between' && target.indicator.row === rows.length ? (
              <DropRule depth={0} />
            ) : null}
          </div>
        </div>
      )}

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={buildMenu({
            node: menu.node,
            onRename: (owner) => void renameNode(menu.node.id, menu.node.title, owner),
            onAddInto: () => setPicker({ mode: 'add', parentId: menu.node.id, nodeId: null }),
            onRelink: () => setPicker({ mode: 'relink', parentId: null, nodeId: menu.node.id }),
            onRemove: () => removeNode(menu.node)
          })}
        />
      ) : null}

      {picker ? (
        <DocumentPicker
          mode={picker.mode}
          onCancel={() => setPicker(null)}
          onConfirm={(paths) => {
            if (picker.mode === 'add') void addDocuments(paths, picker.parentId)
            else if (picker.nodeId && paths[0]) void relink(picker.nodeId, paths[0])
            setPicker(null)
          }}
        />
      ) : null}
    </PanelShell>
  )
}

function buildMenu({
  node,
  onRename,
  onAddInto,
  onRelink,
  onRemove
}: {
  node: ManuscriptNode
  onRename: (owner?: Document) => void
  onAddInto: () => void
  onRelink: () => void
  onRemove: () => void
}): MenuEntry[] {
  const items: MenuEntry[] = [{ label: 'Rename', run: () => onRename() }]
  if (isPart(node)) items.push({ label: 'Add documents here', run: onAddInto })
  else items.push({ label: 'Relink…', run: onRelink })
  items.push({ separator: true })
  items.push({ label: isPart(node) ? 'Remove part' : 'Remove from book', run: onRemove, danger: true })
  return items
}

/** A rule between two rows, indented to the depth it would land at. */
function DropRule({ depth }: { depth: 0 | 1 }) {
  return (
    <span
      data-testid="manuscript-drop-rule"
      className="pointer-events-none absolute -top-px right-1 h-px bg-accent"
      style={{ left: 6 + depth * 12 }}
    />
  )
}

/** A node the resolver has not reported on yet — new since the last `view()`. */
function asResolved(node: ManuscriptNode): ResolvedNode {
  return { ...node, resolvedPath: null, words: 0, missing: false }
}
