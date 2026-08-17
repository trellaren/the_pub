import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useResearchStore } from '@renderer/stores/researchStore.js'
import type { Capture, PdfHighlight } from '@shared/model/research.js'
import { resolveCaptureHighlight } from '@shared/research/captureAnchor.js'
import { ToolbarButton } from '@renderer/ui/primitives.js'

export interface CaptureViewerProps {
  sourceId: string
  attachmentId: string
  onCite?: (highlight: PdfHighlight) => void
}

/**
 * A read-only viewer for a web capture's stored text, with the same
 * select-to-highlight flow `PdfViewer` gives PDFs — anchored by character
 * offset into the capture's immutable text rather than a page/rect, per
 * `captureAnchor.ts`. No pages, no canvas: the whole capture is one flat
 * string, which is what makes this the simpler of the two viewers.
 */
export function CaptureViewer({ sourceId, attachmentId, onCite }: CaptureViewerProps) {
  const readCapture = useResearchStore((store) => store.readCapture)
  const saveHighlight = useResearchStore((store) => store.saveHighlight)
  const highlights = useResearchStore(
    (store) => store.highlightsByAttachment[`${sourceId}/${attachmentId}`] ?? []
  )
  const loadHighlights = useResearchStore((store) => store.loadHighlights)

  const [capture, setCapture] = useState<Capture | null>(null)
  const [selection, setSelection] = useState<{ quote: string; offset: number } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const result = await readCapture(sourceId, attachmentId)
      if (!cancelled) setCapture(result)
    })()
    void loadHighlights(sourceId, attachmentId)
    return () => {
      cancelled = true
    }
  }, [sourceId, attachmentId, readCapture, loadHighlights])

  const captureHighlights = useMemo(
    () => highlights.filter((highlight) => highlight.kind === 'capture'),
    [highlights]
  )

  const segments = useMemo(() => {
    const text = capture?.text ?? ''
    if (!text) return []
    const resolved = captureHighlights
      .map((highlight) => ({ highlight, anchor: resolveCaptureHighlight(highlight, text) }))
      .filter(
        (entry): entry is { highlight: PdfHighlight; anchor: { offset: number; length: number } } =>
          entry.anchor !== null
      )
      .sort((a, b) => a.anchor.offset - b.anchor.offset)

    const result: { text: string; highlight?: PdfHighlight }[] = []
    let cursor = 0
    for (const { highlight, anchor } of resolved) {
      if (anchor.offset < cursor) continue // overlapping selections aren't expected; keep the earlier one
      if (anchor.offset > cursor) result.push({ text: text.slice(cursor, anchor.offset) })
      result.push({ text: text.slice(anchor.offset, anchor.offset + anchor.length), highlight })
      cursor = anchor.offset + anchor.length
    }
    if (cursor < text.length) result.push({ text: text.slice(cursor) })
    return result
  }, [capture, captureHighlights])

  const handleMouseUp = useCallback(() => {
    const sel = window.getSelection()
    const container = containerRef.current
    const text = capture?.text ?? ''
    if (!sel || sel.isCollapsed || !container || !text) {
      setSelection(null)
      return
    }
    const raw = sel.toString()
    const trimmed = raw.trim()
    if (!trimmed) {
      setSelection(null)
      return
    }
    const range = sel.getRangeAt(0)
    const start = textOffsetIn(container, range.startContainer, range.startOffset)
    const leadingWs = raw.length - raw.trimStart().length
    setSelection({ quote: trimmed, offset: start + leadingWs })
  }, [capture])

  const collectSelection = useCallback(async () => {
    if (!selection) return
    const saved = await saveHighlight(sourceId, attachmentId, {
      kind: 'capture',
      color: '#ffef8a',
      quote: selection.quote,
      offset: selection.offset
    })
    setSelection(null)
    window.getSelection()?.removeAllRanges()
    if (saved && onCite) onCite(saved)
  }, [selection, saveHighlight, sourceId, attachmentId, onCite])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1 text-[12px]">
        <span className="truncate font-medium" title={capture?.title}>
          {capture?.title ?? 'Loading…'}
        </span>
        {selection ? (
          <ToolbarButton label="Highlight selection" onClick={() => void collectSelection()}>
            Highlight selection
          </ToolbarButton>
        ) : null}
      </div>
      <div className="relative flex-1 overflow-auto bg-surface-2 p-4">
        <div
          ref={containerRef}
          onMouseUp={handleMouseUp}
          className="max-w-prose whitespace-pre-wrap rounded bg-surface p-4 text-[13px] leading-relaxed text-text shadow"
        >
          {segments.length === 0 ? (
            capture?.text
          ) : (
            segments.map((segment, index) =>
              segment.highlight ? (
                <mark
                  key={segment.highlight.id}
                  style={{ background: segment.highlight.color }}
                  title={segment.highlight.note || undefined}
                >
                  {segment.text}
                </mark>
              ) : (
                // eslint-disable-next-line react/no-array-index-key -- plain-text gaps between highlights have no stable identity
                <span key={index}>{segment.text}</span>
              )
            )
          )}
        </div>
      </div>
    </div>
  )
}

/** Character offset of `(node, nodeOffset)` within `container`'s concatenated text — DOM selections give positions, `captureAnchor` needs plain-string offsets. */
function textOffsetIn(container: Node, node: Node, nodeOffset: number): number {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  let total = 0
  let current: Node | null
  while ((current = walker.nextNode())) {
    if (current === node) return total + nodeOffset
    total += current.textContent?.length ?? 0
  }
  return total
}
