import path from 'node:path'
import { ulid } from 'ulid'
import type { VfsAdapter } from '../vfs/types.js'
import { LocalAdapter } from '../vfs/localAdapter.js'
import {
  templateManifestSchema,
  templateSummarySchema,
  type SaveTemplateOptions,
  type TemplateSummary
} from '../../shared/model/template.js'
import { projectManifestSchema, type ProjectManifest } from '../../shared/model/manifest.js'
import { marginsFromSettings } from '../../shared/model/document.js'
import { migrate } from '../../shared/model/migrate.js'
import {
  MANIFEST_FILE,
  TEMPLATE_MANIFEST_FILE,
  PUB_DIR,
  DOC_EXT,
  LAYOUTS_FILE,
  ENTITIES_FILE,
  BEATS_FILE,
  MAPS_FILE,
  MANUSCRIPT_FILE,
  FORMAT_VERSIONS
} from '../../shared/constants.js'

export interface TemplateDirs {
  /** Ships with the app; read-only. */
  builtin: string
  /** Under `userData`; where "Save as Template…" writes. */
  user: string
}

/**
 * Built-in and user project templates.
 *
 * Takes its two directories rather than reading `app.getPath('userData')`
 * itself, so it carries no Electron import and a test can point it at a
 * temporary directory — the same reason `main/onedrive/` is structured the way
 * it is. It also takes the *adapter* for a target project rather than a URI, so
 * instantiating onto SFTP, FTP or OneDrive needs no code here at all: whoever
 * opened the backend hands it over already opened.
 */
export class TemplateService {
  constructor(private readonly dirs: TemplateDirs) {}

  async list(): Promise<TemplateSummary[]> {
    const builtin = await this.listIn(this.dirs.builtin, 'builtin')
    const user = await this.listIn(this.dirs.user, 'user')
    // Built-ins first, then user templates, each alphabetical — a stable order
    // beats a directory-listing order that differs per filesystem. Re-parsed on
    // the way out so the on-disk directory name, which is this process's
    // business and not the renderer's, stays here.
    return [...sortByName(builtin), ...sortByName(user)].map((summary) =>
      templateSummarySchema.parse(summary)
    )
  }

  /**
   * Write a template's files into an empty (or new) project, and return the
   * manifest the project now has.
   *
   * Every file the template carries is copied verbatim except two: its own
   * `template.json`, which is metadata rather than project content, and the
   * manifest, which is rewritten so the new project gets its own identity. A
   * template that kept the id it was saved from would give every project made
   * from it the same one.
   */
  async instantiate(templateId: string, target: VfsAdapter, projectName: string): Promise<ProjectManifest> {
    const found = await this.find(templateId)
    if (!found) throw new Error(`No such template: ${templateId}`)
    const { dir, manifest: templateManifest } = found
    const source = new LocalAdapter(dir)

    for (const entry of await source.walk('', [])) {
      if (entry.path === TEMPLATE_MANIFEST_FILE || entry.path === MANIFEST_FILE) continue
      const parent = path.posix.dirname(entry.path)
      if (parent && parent !== '.') await target.mkdir(parent)
      await target.writeFileAtomic(entry.path, await source.readFile(entry.path))
    }

    const seeded = await readManifest(source)
    const now = new Date().toISOString()
    const manifest = projectManifestSchema.parse({
      ...seeded,
      formatVersion: FORMAT_VERSIONS.manifest,
      id: ulid(),
      name: projectName,
      created: now,
      modified: now,
      projectType: templateManifest.projectType
    })
    await target.mkdir(PUB_DIR)
    await target.writeFileAtomic(MANIFEST_FILE, encode(manifest))
    return manifest
  }

  /**
   * Snapshot an open project as a user template.
   *
   * The result is a project folder in its own right — it can be opened as one,
   * which is how a template gets edited. Nothing here is live-linked back to
   * the project it came from: changing the source project later must never
   * reach into templates already saved from it, and copying at this moment is
   * what guarantees that rather than a rule someone has to remember.
   */
  async saveAsTemplate(
    source: VfsAdapter,
    manifest: ProjectManifest,
    options: SaveTemplateOptions
  ): Promise<TemplateSummary> {
    const id = ulid()
    const dir = path.join(this.dirs.user, id)
    const target = new LocalAdapter(dir)
    await target.mkdir('')
    await target.mkdir(PUB_DIR)

    await target.writeFileAtomic(
      TEMPLATE_MANIFEST_FILE,
      encode(
        templateManifestSchema.parse({
          id,
          name: options.name,
          description: options.description,
          projectType: options.projectType
        })
      )
    )

    const now = new Date().toISOString()
    await target.writeFileAtomic(
      MANIFEST_FILE,
      encode(
        projectManifestSchema.parse({
          formatVersion: FORMAT_VERSIONS.manifest,
          // A template's own manifest is a real manifest, identity included —
          // `instantiate` replaces all of it. Storing a stripped one would make
          // the template unopenable as the project it claims to be.
          id,
          name: options.name,
          created: now,
          modified: now,
          projectType: options.projectType,
          settings: manifest.settings,
          styles: manifest.styles,
          // Travels with the styles rather than being opt-in: the record kinds
          // *are* the project's vocabulary, and every built-in template ships
          // its own. Leaving them behind turned a thesis saved as a template
          // back into Characters and Locations.
          entityKinds: manifest.entityKinds
        })
      )
    )

    const optional: Array<[boolean, string]> = [
      [options.include.layout, LAYOUTS_FILE],
      [options.include.entities, ENTITIES_FILE],
      [options.include.beats, BEATS_FILE],
      [options.include.maps, MAPS_FILE],
      [options.include.manuscript, MANUSCRIPT_FILE]
    ]
    for (const [wanted, file] of optional) {
      if (!wanted) continue
      await copyIfPresent(source, target, file)
    }
    for (const document of options.include.documents) {
      if (!document.endsWith(DOC_EXT)) continue
      await copyIfPresent(source, target, document)
    }

    return templateSummarySchema.parse({
      id,
      name: options.name,
      description: options.description,
      projectType: options.projectType,
      source: 'user',
      documentCount: options.include.documents.length
    })
  }

  /**
   * A template's styles and page setup, without its content — what "Apply
   * preset" (Phase 12 Part 4) writes over the *current* project. `instantiate`
   * makes a whole new project from a template; this reads only the two
   * fields a submission-format preset carries (`resources/templates/
   * submission-*`), so applying one to an in-progress manuscript cannot touch
   * a single word of prose. The caller merges the result into its own
   * manifest and saves it — this never touches a project's files itself,
   * the same division `instantiate` draws between building a manifest and
   * `saveManifest` persisting one.
   */
  async presetStylesAndPage(templateId: string): Promise<{
    styles: ProjectManifest['styles']
    page: {
      width: number
      height: number
      margins: { top: number; bottom: number; left: number; right: number }
    }
  }> {
    const found = await this.find(templateId)
    if (!found) throw new Error(`No such template: ${templateId}`)
    const seeded = await readManifest(new LocalAdapter(found.dir))
    const manifest = projectManifestSchema.parse({
      ...seeded,
      id: 'preset',
      name: 'preset',
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      projectType: found.manifest.projectType
    })
    return {
      styles: manifest.styles,
      page: {
        width: manifest.settings.pageWidth,
        height: manifest.settings.pageHeight,
        margins: marginsFromSettings(manifest.settings)
      }
    }
  }

  /** Delete a user template. Built-ins ship with the app and cannot be removed. */
  async remove(templateId: string): Promise<void> {
    const found = await this.find(templateId)
    if (!found) return
    if (found.source === 'builtin') throw new Error('Built-in templates cannot be deleted.')
    await new LocalAdapter(path.dirname(found.dir)).delete(path.basename(found.dir), { recursive: true })
  }

  private async find(
    templateId: string
  ): Promise<{ dir: string; source: 'builtin' | 'user'; manifest: TemplateSummary } | null> {
    for (const source of ['builtin', 'user'] as const) {
      for (const summary of await this.listIn(this.dirs[source], source)) {
        if (summary.id !== templateId) continue
        return { dir: path.join(this.dirs[source], summary.directory), source, manifest: summary }
      }
    }
    return null
  }

  private async listIn(
    root: string,
    source: 'builtin' | 'user'
  ): Promise<Array<TemplateSummary & { directory: string }>> {
    const adapter = new LocalAdapter(root)
    let entries
    try {
      entries = await adapter.list('')
    } catch {
      // No templates directory yet — a fresh install has no user templates, and
      // a dev checkout may have no built-ins. Neither is an error.
      return []
    }

    const summaries: Array<TemplateSummary & { directory: string }> = []
    for (const entry of entries) {
      if (entry.kind !== 'dir') continue
      const manifestPath = path.posix.join(entry.path, TEMPLATE_MANIFEST_FILE)
      try {
        const raw = await adapter.readFile(manifestPath)
        const manifest = templateManifestSchema.parse(JSON.parse(raw.toString('utf8')))
        const files = await new LocalAdapter(path.join(root, entry.name)).walk('', [])
        summaries.push({
          ...templateSummarySchema.parse({
            ...manifest,
            source,
            documentCount: files.filter((file) => file.path.endsWith(DOC_EXT)).length
          }),
          directory: entry.name
        })
      } catch {
        // A directory that isn't a template, or a template.json this build
        // can't read. Skip it rather than failing the whole list — one bad
        // user template must not hide every good one.
        continue
      }
    }
    return summaries
  }
}

/**
 * A template's seed manifest, migrated but deliberately *not* yet validated —
 * `instantiate` overwrites the identity fields and parses the result, so
 * asserting the shape twice would only mean rejecting here a template that
 * would have been fixed up a line later.
 */
async function readManifest(source: VfsAdapter): Promise<Record<string, unknown>> {
  const existing = await source.stat(MANIFEST_FILE)
  if (!existing) return {}
  const raw = await source.readFile(MANIFEST_FILE)
  const { value, tooNew } = migrate('manifest', JSON.parse(raw.toString('utf8')))
  if (tooNew) {
    throw new Error('This template was saved by a newer version of The Pub.')
  }
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

async function copyIfPresent(source: VfsAdapter, target: VfsAdapter, file: string): Promise<void> {
  if (!(await source.stat(file))) return
  const parent = path.posix.dirname(file)
  if (parent && parent !== '.') await target.mkdir(parent)
  await target.writeFileAtomic(file, await source.readFile(file))
}

function encode(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function sortByName<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name))
}
