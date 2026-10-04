import path from 'node:path'
import { dialog } from 'electron'
import type { IpcRes } from '../../../shared/ipc/contract.js'
import type { ProjectSession } from '../../services/projectSession.js'
import { assetUrl } from '../../protocol/assetProtocol.js'
import type { ExportItem } from '../../../shared/model/manuscript.js'
import { exportWarnings, type PublishFormat } from '../../../shared/model/publish.js'
import { requirePortableName, type HandlerContext } from '../context.js'

/**
 * `paths` normalises into `items` at the boundary, so `DocxService.export`
 * only ever sees one shape. `items` wins when both are present rather than
 * being merged with it — the two fields describe two different callers
 * (a plain document list versus the manuscript's document-and-heading
 * stream), not two halves of one request.
 */
function resolveExportItems(paths: string[], items: ExportItem[]): ExportItem[] {
  return items.length > 0 ? items : paths.map((path) => ({ kind: 'document' as const, path }))
}

/** What `docx:exportDialog` proposes when the caller has no name of its own. */
function defaultExportName(paths: string[]): string {
  const first = paths[0] ?? 'manuscript'
  return `${path.basename(first).replace(/\.pubdoc$/i, '')}${paths.length > 1 ? ' and others' : ''}`
}

/**
 * Import, having already been handed the files.
 *
 * Every imported document is indexed the way `doc:create` indexes a new one,
 * so a chapter brought in from Word is searchable and has its characters
 * suggested without waiting for the next full pass.
 */
async function importDocxFiles(
  session: ProjectSession,
  files: string[],
  targetDir: string
): Promise<NonNullable<IpcRes<'docx:importDialog'>>> {
  const result = await session.docx.import(files, targetDir, session.manifest)
  if (result.stylesAdded > 0) {
    await session.saveManifest({ ...session.manifest, styles: result.styles })
  }
  for (const document of result.imported) {
    await session.search.indexDocument(document.path).catch(() => {})
  }
  return { imported: result.imported, warnings: result.warnings, stylesAdded: result.stylesAdded }
}

/** Mirrors `importDocxFiles` — see its own comment. */
async function importFountainFiles(
  session: ProjectSession,
  files: string[],
  targetDir: string
): Promise<NonNullable<IpcRes<'fountain:importDialog'>>> {
  const result = await session.fountain.import(files, targetDir)
  for (const document of result.imported) {
    await session.search.indexDocument(document.path).catch(() => {})
  }
  return result
}

/**
 * `publish:export`/`publish:exportDialog` dispatch to the same per-format
 * service the older, still-live `docx:export`/`epub:export`/
 * `fountain:export` channels call — one body shared by both entry points,
 * so a bug fixed here is fixed for every caller rather than one at a time.
 */
async function runPublishExport(
  session: ProjectSession,
  format: PublishFormat,
  paths: string[],
  items: ExportItem[],
  sourcePath: string | undefined,
  file: string
): Promise<void> {
  switch (format) {
    case 'docx':
      return session.docx.export(resolveExportItems(paths, items), file, session.manifest)
    case 'epub':
      return session.epub.export(resolveExportItems(paths, items), file, session.manifest)
    case 'fountain':
      if (!sourcePath) throw new Error('Fountain export needs a document path')
      return session.fountain.export(sourcePath, file)
    case 'pdf':
      return session.print.exportPdf(resolveExportItems(paths, items), file, session.manifest)
    case 'print':
      // `print` has no file to save; `publish:export`/`publish:exportDialog`
      // reuse the same request shape for it anyway (the renderer's dialog
      // is one control for every format) and simply ignore `file`.
      return session.print.print(resolveExportItems(paths, items), session.manifest)
  }
}

const publishExtension: Record<PublishFormat, string> = {
  docx: 'docx',
  epub: 'epub',
  fountain: 'fountain',
  pdf: 'pdf',
  print: 'pdf'
}
const publishDialogTitle: Record<PublishFormat, string> = {
  docx: 'Export to Word',
  epub: 'Export to EPUB',
  fountain: 'Export to Fountain',
  pdf: 'Export to PDF',
  print: 'Print'
}

export function register(ctx: HandlerContext): void {
  const { handle, requireSession, ownerWindow, pickFiles, commitDocumentWrite } = ctx

  handle('doc:read', ({ path: target }, event) => requireSession(event).documents.read(target))

  handle('doc:resolve', ({ docId }, event) => {
    const resolved = requireSession(event).search.resolvePath(docId)
    return resolved ? { path: resolved } : null
  })

  handle('doc:create', async ({ path: target, title }, event) => {
    requirePortableName(target)
    const session = requireSession(event)
    const created = await session.documents.create(target, title)
    await session.search.indexDocument(created.path, created.mtime)
    return created
  })

  handle('doc:write', ({ path: target, doc, expectedMtime }, event) =>
    commitDocumentWrite(event, target, doc, expectedMtime)
  )

  handle('doc:writeAsset', async ({ dataBase64, ext }, event) => {
    const session = requireSession(event)
    const assetPath = await session.documents.writeAsset(dataBase64, ext)
    return { path: assetPath, url: assetUrl(session, assetPath) }
  })

  handle('docx:importDialog', async ({ targetDir }, event) => {
    const session = requireSession(event)
    const files = await pickFiles(event, {
      title: 'Import Word documents',
      filters: [{ name: 'Word documents', extensions: ['docx'] }]
    })
    return files && importDocxFiles(session, files, targetDir)
  })

  handle('docx:export', async ({ paths, items, file }, event) => {
    const session = requireSession(event)
    await session.docx.export(resolveExportItems(paths, items), file, session.manifest)
    return { ok: true as const, file }
  })

  handle('docx:exportDialog', async ({ paths, items, suggestedName }, event) => {
    const session = requireSession(event)
    const suggested = `${suggestedName ?? defaultExportName(paths)}.docx`
    const picked = await dialog.showSaveDialog(ownerWindow(event), {
      title: 'Export to Word',
      defaultPath: suggested,
      filters: [{ name: 'Word documents', extensions: ['docx'] }]
    })
    if (picked.canceled || !picked.filePath) return null
    await session.docx.export(resolveExportItems(paths, items), picked.filePath, session.manifest)
    return { ok: true as const, file: picked.filePath }
  })

  handle('epub:export', async ({ paths, items, file }, event) => {
    const session = requireSession(event)
    await session.epub.export(resolveExportItems(paths, items), file, session.manifest)
    return { ok: true as const, file }
  })

  handle('epub:exportDialog', async ({ paths, items, suggestedName }, event) => {
    const session = requireSession(event)
    const suggested = `${suggestedName ?? defaultExportName(paths)}.epub`
    const picked = await dialog.showSaveDialog(ownerWindow(event), {
      title: 'Export to EPUB',
      defaultPath: suggested,
      filters: [{ name: 'EPUB', extensions: ['epub'] }]
    })
    if (picked.canceled || !picked.filePath) return null
    await session.epub.export(resolveExportItems(paths, items), picked.filePath, session.manifest)
    return { ok: true as const, file: picked.filePath }
  })

  handle('publish:export', async ({ format, path: sourcePath, paths, items, file }, event) => {
    const session = requireSession(event)
    await runPublishExport(session, format, paths, items, sourcePath, file)
    return { ok: true as const, file }
  })

  handle('publish:exportDialog', async ({ format, path: sourcePath, paths, items, suggestedName }, event) => {
    const session = requireSession(event)
    if (format === 'print') {
      await runPublishExport(session, format, paths, items, sourcePath, '')
      return { ok: true as const, file: '' }
    }
    const extension = publishExtension[format]
    const suggested = `${suggestedName ?? defaultExportName(sourcePath ? [sourcePath] : paths)}.${extension}`
    const picked = await dialog.showSaveDialog(ownerWindow(event), {
      title: publishDialogTitle[format],
      defaultPath: suggested,
      filters: [{ name: publishDialogTitle[format], extensions: [extension] }]
    })
    if (picked.canceled || !picked.filePath) return null
    await runPublishExport(session, format, paths, items, sourcePath, picked.filePath)
    return { ok: true as const, file: picked.filePath }
  })

  handle('publish:warnings', ({ format }, event) => {
    return exportWarnings(format, requireSession(event).manifest)
  })

  handle('fountain:importDialog', async ({ targetDir }, event) => {
    const session = requireSession(event)
    const files = await pickFiles(event, {
      title: 'Import Fountain screenplays',
      filters: [{ name: 'Fountain', extensions: ['fountain'] }]
    })
    return files && importFountainFiles(session, files, targetDir)
  })

  handle('fountain:export', async ({ path: sourcePath, file }, event) => {
    await requireSession(event).fountain.export(sourcePath, file)
    return { ok: true as const, file }
  })

  handle('fountain:exportDialog', async ({ path: sourcePath, suggestedName }, event) => {
    const session = requireSession(event)
    const suggested = `${suggestedName ?? defaultExportName([sourcePath])}.fountain`
    const picked = await dialog.showSaveDialog(ownerWindow(event), {
      title: 'Export to Fountain',
      defaultPath: suggested,
      filters: [{ name: 'Fountain', extensions: ['fountain'] }]
    })
    if (picked.canceled || !picked.filePath) return null
    await session.fountain.export(sourcePath, picked.filePath)
    return { ok: true as const, file: picked.filePath }
  })
}
