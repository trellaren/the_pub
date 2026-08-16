import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { TemplateService } from './templateService.js'
import { LocalAdapter } from '../vfs/localAdapter.js'
import { cycleRing, type NamedStyle } from '../../shared/model/style.js'
import { DEFAULT_ENTITY_KINDS } from '../../shared/model/entity.js'

/**
 * Every template shipped under `resources/templates/` — the shape a
 * packaged build actually reads — parses cleanly against this build's live
 * schemas and instantiates into a real project. Nothing else in the suite
 * exercises the on-disk resources directly, so a schema change that quietly
 * broke one of these five would otherwise surface only in the packaged
 * smoke test or, worse, for a user picking that template.
 */
const BUILTIN_TEMPLATES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../resources/templates'
)

let root: string
let projectDir: string
let templates: TemplateService

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-builtin-templates-'))
  projectDir = path.join(root, 'project')
  await fs.mkdir(projectDir, { recursive: true })
  templates = new TemplateService({ builtin: BUILTIN_TEMPLATES_DIR, user: path.join(root, 'user') })
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('the built-in templates on disk', () => {
  it('lists all five', async () => {
    const list = await templates.list()
    expect(list.map((template) => template.id).sort()).toEqual(
      ['builtin-essay', 'builtin-novel', 'builtin-research-paper', 'builtin-screenplay', 'builtin-thesis'].sort()
    )
  })

  it.each([
    'builtin-novel',
    'builtin-thesis',
    'builtin-essay',
    'builtin-research-paper',
    'builtin-screenplay'
  ])('instantiates %s into a real project', async (templateId) => {
    const target = new LocalAdapter(projectDir)
    const manifest = await templates.instantiate(templateId, target, 'Test Project')
    expect(manifest.name).toBe('Test Project')
    expect(manifest.styles.length).toBeGreaterThan(0)
  })

  it('the thesis template numbers its first three heading levels', async () => {
    const manifest = await templates.instantiate('builtin-thesis', new LocalAdapter(projectDir), 'T')
    for (const level of [1, 2, 3]) {
      const style = manifest.styles.find((candidate) => candidate.headingLevel === level)
      expect(style?.numbering).toBeDefined()
    }
    expect(manifest.entityKinds?.map((def) => def.id)).toEqual(['interviewee', 'concept', 'source'])
    expect(manifest.settings.citationStyleId).toBe('chicago-notes-bibliography')
  })

  it('the thesis template pre-creates its front and back matter parts', async () => {
    await templates.instantiate('builtin-thesis', new LocalAdapter(projectDir), 'T')
    const manuscript = JSON.parse(await fs.readFile(path.join(projectDir, '.thepub', 'manuscript.json'), 'utf8'))
    const roles = manuscript.nodes.map((node: { role: string }) => node.role)
    expect(roles.filter((role: string) => role === 'front')).toHaveLength(3)
    expect(roles.filter((role: string) => role === 'back')).toHaveLength(1)
  })

  it('the essay template sets MLA with no heading numbered', async () => {
    const manifest = await templates.instantiate('builtin-essay', new LocalAdapter(projectDir), 'E')
    expect(manifest.settings.citationStyleId).toBe('modern-language-association')
    expect(manifest.styles.every((style) => !style.numbering)).toBe(true)
  })

  it('the research paper template numbers headings under APA', async () => {
    const manifest = await templates.instantiate('builtin-research-paper', new LocalAdapter(projectDir), 'R')
    expect(manifest.settings.citationStyleId).toBe('apa')
    expect(manifest.styles.some((style) => style.numbering)).toBe(true)
  })

  it('the screenplay template omits entityKinds, falling back to the fiction defaults', async () => {
    const manifest = await templates.instantiate('builtin-screenplay', new LocalAdapter(projectDir), 'S')
    expect(manifest.entityKinds).toBeUndefined()
    expect(DEFAULT_ENTITY_KINDS.map((def) => def.id)).toEqual(['character', 'location'])
  })

  it("the screenplay template's Tab ring visits every element and returns to its start", async () => {
    const manifest = await templates.instantiate('builtin-screenplay', new LocalAdapter(projectDir), 'S')
    const styles: NamedStyle[] = manifest.styles
    const ring = cycleRing('scene-heading', styles)
    // Every other style, then back — `cycleRing` excludes the start itself and
    // stops the moment it returns, so a healthy 6-element ring reports 5.
    expect(ring).toHaveLength(5)
    expect(new Set(ring).size).toBe(5)
    const last = styles.find((style) => style.id === ring.at(-1))
    expect(last?.cycleStyle).toBe('scene-heading')
  })
})
