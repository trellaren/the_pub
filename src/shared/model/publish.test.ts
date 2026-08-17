import { describe, it, expect } from 'vitest'
import { exportWarnings } from './publish.js'
import { projectManifestSchema, type ProjectManifest } from './manifest.js'
import { BUILTIN_STYLES } from './style.js'

function manifest(patch: Partial<ProjectManifest> = {}): ProjectManifest {
  return projectManifestSchema.parse({
    id: 'proj-1',
    name: 'Test Book',
    created: new Date().toISOString(),
    modified: new Date().toISOString(),
    styles: BUILTIN_STYLES,
    ...patch
  })
}

describe('exportWarnings', () => {
  it('warns EPUB has no page numbers and, without a cover, no cover', () => {
    const warnings = exportWarnings('epub', manifest())
    expect(warnings.some((w) => w.includes('page'))).toBe(true)
    expect(warnings.some((w) => w.includes('cover'))).toBe(true)
  })

  it('drops the missing-cover warning once one is set', () => {
    const warnings = exportWarnings('epub', manifest({ publication: { coverImagePath: 'assets/cover.png' } }))
    expect(warnings.some((w) => w.includes('cover'))).toBe(false)
  })

  it('warns PDF and print cannot reflow', () => {
    expect(exportWarnings('pdf', manifest()).some((w) => w.includes('reflow'))).toBe(true)
    expect(exportWarnings('print', manifest()).some((w) => w.includes('reflow'))).toBe(true)
  })

  it('has no warnings for docx', () => {
    expect(exportWarnings('docx', manifest())).toEqual([])
  })

  it('warns fountain drops rich formatting', () => {
    expect(exportWarnings('fountain', manifest()).length).toBeGreaterThan(0)
  })
})
