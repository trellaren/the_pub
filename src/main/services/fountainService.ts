import fs from 'node:fs/promises'
import path from 'node:path'
import type { VfsAdapter } from '../vfs/types.js'
import type { DocumentService } from './documentService.js'
import { DOC_EXT } from '../../shared/constants.js'
import { joinRelative } from '../vfs/paths.js'
import { sanitizeFileName } from '../../shared/model/filename.js'
import { importFountain } from '../fountain/fromFountain.js'
import { exportFountain } from '../fountain/toFountain.js'

export interface ImportedFountainDocument {
  path: string
  title: string
  docId: string
}

export interface FountainImportResult {
  imported: ImportedFountainDocument[]
  warnings: string[]
}

/**
 * Fountain screenplays in and out.
 *
 * The conversion itself is pure and lives in `../fountain/`; this is the part
 * that knows where a project is — the same asymmetry `DocxService` documents:
 * a `.fountain` being imported sits outside the project and is read with
 * `fs`, while what's written lands inside the project through the adapter, so
 * import works over SFTP and FTP exactly as it does locally. Export is the
 * mirror: read through the adapter, write with `fs`, since the destination is
 * wherever the author chose to save it.
 *
 * One document at a time, unlike `DocxService.export`'s whole-binder stream —
 * a screenplay is conventionally one continuous script, not chapters, so
 * there is no part-heading or multi-document case to support here.
 */
export class FountainService {
  constructor(
    private readonly adapter: VfsAdapter,
    private readonly documents: DocumentService
  ) {}

  async import(files: string[], targetDir: string): Promise<FountainImportResult> {
    const imported: ImportedFountainDocument[] = []
    const warnings: string[] = []

    for (const file of files) {
      const source = await fs.readFile(file, 'utf8')
      const result = importFountain(source)
      const title = result.title ?? path.basename(file).replace(/\.fountain$/i, '')
      const docPath = await this.freePath(targetDir, title)
      const created = await this.documents.create(docPath, title)
      const written = await this.documents.write(
        created.path,
        { ...created.doc, content: result.content },
        created.mtime
      )
      if (!written.ok) {
        warnings.push(`${title} could not be written: the file changed underneath the import.`)
        continue
      }
      imported.push({ path: created.path, title, docId: created.doc.docId })
    }

    return { imported, warnings }
  }

  /** Write one project document to a `.fountain` file at an absolute path. */
  async export(sourcePath: string, file: string): Promise<void> {
    const loaded = await this.documents.read(sourcePath)
    const text = exportFountain(loaded.doc.content, { title: loaded.doc.title })
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, text, 'utf8')
  }

  /** A path in `targetDir` for this title that no file already occupies. */
  private async freePath(targetDir: string, title: string): Promise<string> {
    const stem = sanitizeFileName(title, 'Imported')
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const name = attempt === 0 ? `${stem}${DOC_EXT}` : `${stem} (${attempt})${DOC_EXT}`
      const candidate = joinRelative(targetDir, name)
      if (!(await this.adapter.stat(candidate))) return candidate
    }
    return joinRelative(targetDir, `${stem} (${Date.now()})${DOC_EXT}`)
  }
}
