import { useEffect, useRef, useState, useCallback } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
// Bundled locally so the worker never has to reach a CDN — the production
// CSP (`src/main/index.ts`) is `connect-src 'self' data:`, and Vite's `?url`
// import resolves to a same-origin asset URL at build time either way.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'
import { useResearchStore } from '@renderer/stores/researchStore.js'
import type { PdfHighlight } from '@shared/model/research.js'
import { ToolbarButton } from '@renderer/ui/primitives.js'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

export interface PdfViewerProps {
  sourceId: string
  attachmentId: string
  /** Jump to this page on open — used by the Sources tab's click-to-jump. */
  initialPage?: number
  onCite?: (highlight: PdfHighlight) => void
}

/**
 * A minimal pdf.js reader: canvas rendering plus the text layer that makes
 * selection — and therefore highlighting — possible at all. Paginates one
 * page at a time rather than a continuous scroll; a research PDF reader
 * doesn't need more than that to be useful, and it keeps this component
 * small enough to actually finish.
 */
export function PdfViewer({ sourceId, attachmentId, initialPage, onCite }: PdfViewerProps) {
  const readPdf = useResearchStore((store) => store.readPdf)
  const saveHighlight = useResearchStore((store) => store.saveHighlight)
  const highlights = useResearchStore(
    (store) => store.highlightsByAttachment[`${sourceId}/${attachmentId}`] ?? []
  )
  const loadHighlights = useResearchStore((store) => store.loadHighlights)

  const [doc, setDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null)
  const [page, setPage] = useState(initialPage ?? 1)
  const [selection, setSelection] = useState<{ quote: string; rects: [number, number, number, number][] } | null>(
    null
  )
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const bytes = await readPdf(sourceId, attachmentId)
      if (!bytes || cancelled) return
      const loaded = await pdfjsLib.getDocument({ data: bytes }).promise
      if (cancelled) return
      setDoc(loaded)
    })()
    void loadHighlights(sourceId, attachmentId)
    return () => {
      cancelled = true
    }
  }, [sourceId, attachmentId, readPdf, loadHighlights])

  useEffect(() => {
    if (!doc || !canvasRef.current) return
    let cancelled = false
    void (async () => {
      const pdfPage = await doc.getPage(Math.min(Math.max(page, 1), doc.numPages))
      if (cancelled) return
      const viewport = pdfPage.getViewport({ scale: 1.4 })
      const canvas = canvasRef.current!
      const ctx = canvas.getContext('2d')!
      canvas.width = viewport.width
      canvas.height = viewport.height
      await pdfPage.render({ canvasContext: ctx, viewport }).promise
      if (cancelled) return

      const textLayer = textLayerRef.current
      if (textLayer) {
        textLayer.innerHTML = ''
        textLayer.style.width = `${viewport.width}px`
        textLayer.style.height = `${viewport.height}px`
        const content = await pdfPage.getTextContent()
        if (cancelled) return
        for (const item of content.items) {
          if (!('str' in item) || !item.str) continue
          const span = document.createElement('span')
          span.textContent = item.str
          const tx = pdfjsLib.Util.transform(
            pdfjsLib.Util.transform(viewport.transform, item.transform),
            [1, 0, 0, -1, 0, 0]
          )
          const fontHeight = Math.hypot(tx[2]!, tx[3]!)
          span.style.position = 'absolute'
          span.style.left = `${tx[4]}px`
          span.style.top = `${tx[5]! - fontHeight}px`
          span.style.fontSize = `${fontHeight}px`
          span.style.fontFamily = 'sans-serif'
          span.style.whiteSpace = 'pre'
          span.style.color = 'transparent'
          span.style.cursor = 'text'
          textLayer.appendChild(span)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [doc, page])

  const handleMouseUp = useCallback(() => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !textLayerRef.current) {
      setSelection(null)
      return
    }
    const quote = sel.toString().trim()
    if (!quote) {
      setSelection(null)
      return
    }
    const layerBounds = textLayerRef.current.getBoundingClientRect()
    const rects: [number, number, number, number][] = []
    for (let i = 0; i < sel.rangeCount; i++) {
      const range = sel.getRangeAt(i)
      for (const rect of Array.from(range.getClientRects())) {
        rects.push([
          rect.left - layerBounds.left,
          rect.top - layerBounds.top,
          rect.right - layerBounds.left,
          rect.bottom - layerBounds.top
        ])
      }
    }
    setSelection({ quote, rects })
  }, [])

  const collectSelection = useCallback(async () => {
    if (!selection) return
    const saved = await saveHighlight(sourceId, attachmentId, {
      color: '#ffef8a',
      quote: selection.quote,
      page,
      rects: selection.rects
    })
    setSelection(null)
    window.getSelection()?.removeAllRanges()
    if (saved && onCite) onCite(saved)
  }, [selection, saveHighlight, sourceId, attachmentId, page, onCite])

  const pageHighlights = highlights.filter((h) => h.page === page)

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1 text-[12px]">
        <ToolbarButton label="Previous page" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1}>
          Prev
        </ToolbarButton>
        <span>
          Page {page} {doc ? `of ${doc.numPages}` : ''}
        </span>
        <ToolbarButton
          label="Next page"
          onClick={() => setPage((current) => Math.min(doc?.numPages ?? current, current + 1))}
          disabled={!doc || page >= doc.numPages}
        >
          Next
        </ToolbarButton>
        {selection ? (
          <ToolbarButton label="Highlight selection" onClick={() => void collectSelection()}>Highlight selection</ToolbarButton>
        ) : null}
        {pageHighlights.length > 0 ? (
          <span className="text-muted">{pageHighlights.length} highlight(s) on this page</span>
        ) : null}
      </div>
      <div className="relative flex-1 overflow-auto bg-surface-2 p-4">
        <div className="relative inline-block" onMouseUp={handleMouseUp}>
          <canvas ref={canvasRef} className="block shadow" />
          <div ref={textLayerRef} className="pdf-text-layer absolute left-0 top-0" />
        </div>
      </div>
    </div>
  )
}
