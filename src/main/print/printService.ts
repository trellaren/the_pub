import fs from 'node:fs/promises'
import path from 'node:path'
import { BrowserWindow } from 'electron'
import type { VfsAdapter } from '../vfs/types.js'
import type { DocumentService } from '../services/documentService.js'
import type { ProjectManifest } from '../../shared/model/manifest.js'
import type { PageSetup, PmNode, Section } from '../../shared/model/document.js'
import type { ExportItem } from '../../shared/model/manuscript.js'
import { ASSETS_DIR, ASSET_PROTOCOL } from '../../shared/constants.js'
import { parseAssetUrl } from '../../shared/model/asset.js'
import { relativeToRoot, basename } from '../vfs/paths.js'
import { buildPrintHtml, type PrintDocument, type PrintImage } from './printDocument.js'
import { buildPdfOptions } from './printOptions.js'

export interface RendererServerLike {
  servePrintJob: (html: string) => { url: string; revoke: () => void }
}

export interface RunningHeader {
  /** `Surname / TITLE / page` — page number is filled in by `printToPDF`'s own `headerTemplate` token. */
  text: string
}

/**
 * PDF and Print, both consumers of the same offscreen render.
 *
 * Mirrors `EpubService`/`DocxService` in shape (`ExportItem[]` + manifest in,
 * bytes or a system print dialog out) but the render itself happens in a real
 * Chromium page rather than a pure serializer: `printToPDF`/`print` need an
 * actual DOM, so the HTML `buildPrintHtml` produces is loaded into an
 * offscreen `BrowserWindow` — on the loopback `rendererServer` when one is
 * running (a packaged app, and `npm run dev` once the main process starts
 * one), or a `data:` URL otherwise, so this also works in a unit/e2e host
 * with no `rendererServer` wired up.
 *
 * The window is always destroyed in `finally`, the same ownership discipline
 * `AiRunner` applies to its `AbortController` — a render or print failure
 * must never leak a hidden window.
 */
export class PrintService {
  constructor(
    private readonly adapter: VfsAdapter,
    private readonly documents: DocumentService,
    private readonly rendererServer?: RendererServerLike
  ) {}

  async exportPdf(items: ExportItem[], file: string, manifest: ProjectManifest): Promise<void> {
    const buffer = await this.render(items, manifest, (webContents, setup) =>
      webContents.printToPDF(buildPdfOptions(setup, this.runningHeaderFooter(manifest)))
    )
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, buffer)
  }

  /** Same route, `webContents.print` instead of `printToPDF` — what prints and what exports as PDF are the same pixels. */
  async print(items: ExportItem[], manifest: ProjectManifest): Promise<void> {
    await this.render(items, manifest, (webContents, setup) => {
      return new Promise<Buffer>((resolve, reject) => {
        webContents.print(
          { silent: false, printBackground: true, landscape: setup.orientation === 'landscape' },
          (ok, error) => {
            if (ok) resolve(Buffer.alloc(0))
            else reject(new Error(error || 'Print was not completed.'))
          }
        )
      })
    })
  }

  private async render(
    items: ExportItem[],
    manifest: ProjectManifest,
    run: (webContents: Electron.WebContents, setup: PageSetup) => Promise<Buffer>
  ): Promise<Buffer> {
    const documents: PrintDocument[] = []
    let firstSection: Section | undefined
    for (const item of items) {
      if (item.kind === 'heading') {
        documents.push({ title: item.title, content: headingDocument(item.title) })
        continue
      }
      const loaded = await this.documents.read(item.path)
      documents.push({ title: loaded.doc.title, content: loaded.doc.content })
      if (!firstSection) firstSection = loaded.doc.sections?.[0]
    }

    const setup: PageSetup = firstSection
      ? firstSection.page
      : {
          width: manifest.settings.pageWidth,
          height: manifest.settings.pageHeight,
          margin: manifest.settings.pageMargin,
          orientation: 'portrait',
          columns: 1
        }

    const images = await this.readImages(documents)
    const html = buildPrintHtml(documents, manifest.styles, setup, images)

    let window: BrowserWindow | null = null
    let revoke: (() => void) | null = null
    try {
      window = new BrowserWindow({
        show: false,
        webPreferences: { offscreen: true, sandbox: true }
      })

      const served = this.rendererServer?.servePrintJob(html)
      revoke = served?.revoke ?? null
      const url = served?.url ?? `data:text/html;charset=utf-8;base64,${Buffer.from(html).toString('base64')}`

      await window.loadURL(url)
      // Fonts and images must be settled before measuring/printing a page —
      // `document.fonts.ready` covers the former, and every `<img>` in the
      // print HTML is a `data:` URI (see `buildPrintHtml`), so there is no
      // network image load to wait on separately.
      await window.webContents.executeJavaScript('document.fonts.ready.then(() => true)')

      return await run(window.webContents, setup)
    } finally {
      revoke?.()
      window?.destroy()
    }
  }

  private runningHeaderFooter(manifest: ProjectManifest): { header?: string; footer?: string } | undefined {
    const surname = (manifest.publication.authorName ?? '').trim().split(/\s+/).pop()
    if (!surname) return undefined
    const title = manifest.name.toUpperCase()
    return {
      header: `<div style="font-size: 9px; width: 100%; text-align: right;">${escapeHtml(surname)} / ${escapeHtml(title)} / <span class="pageNumber"></span></div>`
    }
  }

  private async readImages(documents: PrintDocument[]): Promise<Map<string, PrintImage>> {
    const sources = new Set<string>()
    for (const document of documents) collectImageSources(document.content.content ?? [], sources)

    const found = new Map<string, PrintImage>()
    for (const src of sources) {
      const relative = this.assetPathFor(src)
      if (!relative) continue
      try {
        const data = await this.adapter.readFile(relative)
        const extension = basename(relative).split('.').pop() ?? 'png'
        found.set(basename(relative), { data: new Uint8Array(data), extension })
      } catch {
        // A missing image is a gap in the printed page, not a failed export.
      }
    }
    return found
  }

  /** Mirrors `EpubService.assetPathFor`. */
  private assetPathFor(src: string): string | null {
    if (!src.startsWith(`${ASSET_PROTOCOL}://`)) {
      return src.startsWith(`${ASSETS_DIR}/`) ? src : null
    }
    const parsed = parseAssetUrl(src)
    if (!parsed) return null
    if (parsed.kind === 'project') return parsed.path
    let absolute: string
    try {
      absolute = Buffer.from(parsed.encoded, 'base64url').toString('utf8')
    } catch {
      return null
    }
    try {
      const relative = relativeToRoot(this.adapter.root, absolute)
      if (relative && !relative.startsWith('..')) return relative
    } catch {
      // Fall through to the assets-segment search.
    }
    const marker = absolute.replace(/\\/g, '/').lastIndexOf(`${ASSETS_DIR}/`)
    return marker === -1 ? null : absolute.replace(/\\/g, '/').slice(marker)
  }
}

function headingDocument(title: string) {
  return {
    type: 'doc' as const,
    content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: title }] }]
  }
}

function collectImageSources(nodes: PmNode[], found: Set<string>): void {
  for (const node of nodes) {
    if (node.type === 'image' && typeof node.attrs?.src === 'string') found.add(node.attrs.src)
    if (node.content) collectImageSources(node.content, found)
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
