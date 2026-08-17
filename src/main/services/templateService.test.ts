import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { TemplateService } from './templateService.js'
import { LocalAdapter } from '../vfs/localAdapter.js'
import { EntityService } from './entityService.js'
import { MANIFEST_FILE, ENTITIES_FILE } from '../../shared/constants.js'
import { projectManifestSchema, type ProjectManifest } from '../../shared/model/manifest.js'
import { BUILTIN_STYLES } from '../../shared/model/style.js'

let root: string
let builtinDir: string
let userDir: string
let templates: TemplateService

/** A minimal template directory, laid out exactly as `resources/templates/novel` is. */
async function writeTemplate(
  dir: string,
  id: string,
  overrides: { name?: string; projectType?: string; manifest?: Record<string, unknown> } = {}
): Promise<void> {
  await fs.mkdir(path.join(dir, '.thepub'), { recursive: true })
  await fs.writeFile(
    path.join(dir, 'template.json'),
    JSON.stringify({
      id,
      name: overrides.name ?? 'Novel',
      description: 'A blank manuscript.',
      projectType: overrides.projectType ?? 'novel'
    })
  )
  await fs.writeFile(
    path.join(dir, MANIFEST_FILE),
    JSON.stringify({
      formatVersion: 2,
      id,
      name: overrides.name ?? 'Novel',
      created: '2026-01-01T00:00:00.000Z',
      modified: '2026-01-01T00:00:00.000Z',
      projectType: overrides.projectType ?? 'novel',
      settings: {},
      ...overrides.manifest
    })
  )
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-templates-'))
  builtinDir = path.join(root, 'builtin')
  userDir = path.join(root, 'user')
  await fs.mkdir(builtinDir, { recursive: true })
  await fs.mkdir(userDir, { recursive: true })
  templates = new TemplateService({ builtin: builtinDir, user: userDir })
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('TemplateService.list', () => {
  it('is empty when neither directory has anything', async () => {
    expect(await templates.list()).toEqual([])
  })

  it('lists built-ins before user templates, each alphabetical', async () => {
    await writeTemplate(path.join(builtinDir, 'novel'), 'builtin-novel', { name: 'Novel' })
    await writeTemplate(path.join(userDir, 'b'), 'user-b', { name: 'Zebra' })
    await writeTemplate(path.join(userDir, 'a'), 'user-a', { name: 'Alpha' })

    const list = await templates.list()
    expect(list.map((t) => [t.source, t.name])).toEqual([
      ['builtin', 'Novel'],
      ['user', 'Alpha'],
      ['user', 'Zebra']
    ])
  })

  it('skips a directory with no template.json rather than failing the whole list', async () => {
    await writeTemplate(path.join(builtinDir, 'novel'), 'builtin-novel')
    await fs.mkdir(path.join(builtinDir, 'not-a-template'), { recursive: true })

    const list = await templates.list()
    expect(list.map((t) => t.id)).toEqual(['builtin-novel'])
  })

  it('counts seeded documents', async () => {
    const dir = path.join(builtinDir, 'novel')
    await writeTemplate(dir, 'builtin-novel')
    await fs.writeFile(path.join(dir, 'chapter-1.pubdoc'), '{}')

    const [summary] = await templates.list()
    expect(summary!.documentCount).toBe(1)
  })
})

describe('TemplateService.instantiate', () => {
  beforeEach(async () => {
    await writeTemplate(path.join(builtinDir, 'novel'), 'builtin-novel', { name: 'Novel' })
  })

  it('gives the new project its own identity, not the template’s', async () => {
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-target-'))
    const target = new LocalAdapter(targetDir)
    try {
      const manifest = await templates.instantiate('builtin-novel', target, 'My Novel')
      expect(manifest.id).not.toBe('builtin-novel')
      expect(manifest.name).toBe('My Novel')
      expect(manifest.projectType).toBe('novel')
      expect(manifest.styles).toEqual(BUILTIN_STYLES)

      const onDisk = projectManifestSchema.parse(
        JSON.parse(await fs.readFile(path.join(targetDir, MANIFEST_FILE), 'utf8'))
      )
      expect(onDisk.id).toBe(manifest.id)
    } finally {
      await target.dispose()
      await fs.rm(targetDir, { recursive: true, force: true })
    }
  })

  it('does not write the template’s own template.json into the project', async () => {
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-target-'))
    const target = new LocalAdapter(targetDir)
    try {
      await templates.instantiate('builtin-novel', target, 'My Novel')
      await expect(fs.stat(path.join(targetDir, 'template.json'))).rejects.toThrow()
    } finally {
      await target.dispose()
      await fs.rm(targetDir, { recursive: true, force: true })
    }
  })

  it('copies seeded project files verbatim', async () => {
    await fs.writeFile(path.join(builtinDir, 'novel', 'chapter-1.pubdoc'), '{"hello":true}')
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-target-'))
    const target = new LocalAdapter(targetDir)
    try {
      await templates.instantiate('builtin-novel', target, 'My Novel')
      const copied = await fs.readFile(path.join(targetDir, 'chapter-1.pubdoc'), 'utf8')
      expect(copied).toBe('{"hello":true}')
    } finally {
      await target.dispose()
      await fs.rm(targetDir, { recursive: true, force: true })
    }
  })

  it('rejects an unknown template id', async () => {
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-target-'))
    const target = new LocalAdapter(targetDir)
    try {
      await expect(templates.instantiate('no-such-template', target, 'x')).rejects.toThrow()
    } finally {
      await target.dispose()
      await fs.rm(targetDir, { recursive: true, force: true })
    }
  })

  it('never mutates the template it read from', async () => {
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-target-'))
    const target = new LocalAdapter(targetDir)
    try {
      await templates.instantiate('builtin-novel', target, 'One')
      await templates.instantiate('builtin-novel', target, 'Two')
      const templateManifest = JSON.parse(
        await fs.readFile(path.join(builtinDir, 'novel', MANIFEST_FILE), 'utf8')
      ) as ProjectManifest
      expect(templateManifest.id).toBe('builtin-novel')
      expect(templateManifest.name).toBe('Novel')
    } finally {
      await target.dispose()
      await fs.rm(targetDir, { recursive: true, force: true })
    }
  })
})

describe('TemplateService.saveAsTemplate', () => {
  it('always carries styles and settings, and nothing else by default', async () => {
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-source-'))
    const source = new LocalAdapter(sourceDir)
    const entities = new EntityService(source)
    await entities.create('character', 'Someone the template must not carry')

    try {
      const manifest: ProjectManifest = projectManifestSchema.parse({
        id: 'p1',
        name: 'Draft',
        created: '2026-01-01T00:00:00.000Z',
        modified: '2026-01-01T00:00:00.000Z',
        settings: { defaultStyleId: 'body' },
        styles: BUILTIN_STYLES
      })

      const summary = await templates.saveAsTemplate(source, manifest, {
        name: 'My Template',
        description: 'desc',
        projectType: 'novel',
        include: { entities: false, beats: false, maps: false, manuscript: false, layout: false, documents: [] }
      })

      expect(summary.source).toBe('user')
      const savedManifestRaw = await fs.readFile(path.join(userDir, summary.id, MANIFEST_FILE), 'utf8')
      const saved = projectManifestSchema.parse(JSON.parse(savedManifestRaw))
      expect(saved.styles).toEqual(BUILTIN_STYLES)
      expect(saved.settings.defaultStyleId).toBe('body')

      await expect(fs.stat(path.join(userDir, summary.id, ENTITIES_FILE))).rejects.toThrow()
    } finally {
      await source.dispose()
      await fs.rm(sourceDir, { recursive: true, force: true })
    }
  })

  /*
   * The record kinds are the project's vocabulary, and every built-in template
   * ships its own. Dropping them turned a thesis saved as a template back into
   * Characters and Locations — invisible until a project made from it opened
   * with the wrong panels.
   */
  it('carries the project’s record kinds, not just its styles', async () => {
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-source-'))
    const source = new LocalAdapter(sourceDir)

    try {
      const entityKinds = [
        { id: 'interviewee', label: 'Interviewee', labelPlural: 'Interviewees' },
        { id: 'concept', label: 'Concept', labelPlural: 'Concepts' }
      ]
      const manifest: ProjectManifest = projectManifestSchema.parse({
        id: 'p1',
        name: 'Fieldwork',
        created: '2026-01-01T00:00:00.000Z',
        modified: '2026-01-01T00:00:00.000Z',
        settings: {},
        styles: BUILTIN_STYLES,
        entityKinds
      })

      const summary = await templates.saveAsTemplate(source, manifest, {
        name: 'Fieldwork Template',
        description: '',
        projectType: 'thesis',
        include: { entities: false, beats: false, maps: false, manuscript: false, layout: false, documents: [] }
      })

      const savedRaw = await fs.readFile(path.join(userDir, summary.id, MANIFEST_FILE), 'utf8')
      const saved = projectManifestSchema.parse(JSON.parse(savedRaw))
      expect(saved.entityKinds).toEqual(entityKinds)
    } finally {
      await source.dispose()
      await fs.rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('leaves the record kinds absent when the project never set any', async () => {
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-source-'))
    const source = new LocalAdapter(sourceDir)

    try {
      const manifest: ProjectManifest = projectManifestSchema.parse({
        id: 'p1',
        name: 'Draft',
        created: '2026-01-01T00:00:00.000Z',
        modified: '2026-01-01T00:00:00.000Z',
        settings: {},
        styles: BUILTIN_STYLES
      })

      const summary = await templates.saveAsTemplate(source, manifest, {
        name: 'Plain',
        description: '',
        projectType: 'novel',
        include: { entities: false, beats: false, maps: false, manuscript: false, layout: false, documents: [] }
      })

      const savedRaw = await fs.readFile(path.join(userDir, summary.id, MANIFEST_FILE), 'utf8')
      // Absent, not an empty list: absent means the fiction defaults, while an
      // empty array would be a project offering no record panels at all.
      expect(projectManifestSchema.parse(JSON.parse(savedRaw)).entityKinds).toBeUndefined()
    } finally {
      await source.dispose()
      await fs.rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('includes entities only when opted in', async () => {
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-source-'))
    const source = new LocalAdapter(sourceDir)
    const entities = new EntityService(source)
    await entities.create('character', 'Included Character')

    try {
      const manifest: ProjectManifest = projectManifestSchema.parse({
        id: 'p1',
        name: 'Draft',
        created: '2026-01-01T00:00:00.000Z',
        modified: '2026-01-01T00:00:00.000Z',
        settings: {},
        styles: BUILTIN_STYLES
      })

      const summary = await templates.saveAsTemplate(source, manifest, {
        name: 'My Template',
        description: '',
        projectType: 'novel',
        include: { entities: true, beats: false, maps: false, manuscript: false, layout: false, documents: [] }
      })

      const copied = await fs.readFile(path.join(userDir, summary.id, ENTITIES_FILE), 'utf8')
      expect(JSON.parse(copied).entities).toHaveLength(1)
    } finally {
      await source.dispose()
      await fs.rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('is a one-shot copy: editing the source project after saving does not reach the template', async () => {
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-source-'))
    const source = new LocalAdapter(sourceDir)
    const entities = new EntityService(source)
    await entities.create('character', 'Before')

    try {
      const manifest: ProjectManifest = projectManifestSchema.parse({
        id: 'p1',
        name: 'Draft',
        created: '2026-01-01T00:00:00.000Z',
        modified: '2026-01-01T00:00:00.000Z',
        settings: {},
        styles: BUILTIN_STYLES
      })
      const summary = await templates.saveAsTemplate(source, manifest, {
        name: 'My Template',
        description: '',
        projectType: 'novel',
        include: { entities: true, beats: false, maps: false, manuscript: false, layout: false, documents: [] }
      })

      await entities.create('character', 'After the template was saved')

      const copied = JSON.parse(
        await fs.readFile(path.join(userDir, summary.id, ENTITIES_FILE), 'utf8')
      ) as { entities: { name: string }[] }
      expect(copied.entities.map((e) => e.name)).toEqual(['Before'])
    } finally {
      await source.dispose()
      await fs.rm(sourceDir, { recursive: true, force: true })
    }
  })
})

describe('TemplateService.remove', () => {
  it('refuses to delete a built-in template', async () => {
    await writeTemplate(path.join(builtinDir, 'novel'), 'builtin-novel')
    await expect(templates.remove('builtin-novel')).rejects.toThrow()
    expect(await templates.list()).toHaveLength(1)
  })

  it('deletes a user template', async () => {
    await writeTemplate(path.join(userDir, 'mine'), 'user-mine')
    await templates.remove('user-mine')
    expect(await templates.list()).toEqual([])
  })

  it('is a no-op for an id that does not exist', async () => {
    await expect(templates.remove('nope')).resolves.toBeUndefined()
  })
})

describe('TemplateService.presetStylesAndPage', () => {
  it('returns only the styles and page setup, never a project the caller could mistake for content', async () => {
    await writeTemplate(path.join(builtinDir, 'submission'), 'builtin-submission', {
      manifest: {
        settings: { pageWidth: 612, pageHeight: 792, pageMargin: 72 },
        styles: BUILTIN_STYLES.map((style) =>
          style.id === 'body' ? { ...style, text: { ...style.text, fontSize: 12 }, paragraph: { ...style.paragraph, lineHeight: 2 } } : style
        )
      }
    })

    const preset = await templates.presetStylesAndPage('builtin-submission')
    expect(preset.page).toEqual({ width: 612, height: 792, margin: 72 })
    const body = preset.styles.find((style) => style.id === 'body')
    expect(body?.paragraph.lineHeight).toBe(2)
  })

  it("applying a preset's styles/page over a project changes no `.pubdoc`'s content", async () => {
    await writeTemplate(path.join(builtinDir, 'submission'), 'builtin-submission', {
      manifest: { settings: { pageWidth: 612, pageHeight: 792, pageMargin: 72 } }
    })
    const preset = await templates.presetStylesAndPage('builtin-submission')

    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-tpl-project-'))
    const project = new LocalAdapter(projectDir)
    try {
      await project.mkdir('.thepub')
      const docBefore = {
        formatVersion: 6,
        docId: 'd1',
        title: 'Chapter One',
        created: '2026-01-01T00:00:00.000Z',
        modified: '2026-01-01T00:00:00.000Z',
        wordCount: 2,
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] }] }
      }
      await project.writeFileAtomic('chapter-01.pubdoc', Buffer.from(JSON.stringify(docBefore)))

      // The whole point of "Apply preset": the manifest's styles/page setup
      // change, the document is never opened or rewritten at all.
      void preset

      const after = JSON.parse(await project.readFile('chapter-01.pubdoc').then((b) => b.toString('utf8')))
      expect(after).toEqual(docBefore)
    } finally {
      await project.dispose()
      await fs.rm(projectDir, { recursive: true, force: true })
    }
  })
})
