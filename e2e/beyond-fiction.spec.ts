import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { launch, openProject, createDocument, cleanup, readJson, waitFor, type Harness } from './helpers.js'
import type { PubDocument } from '../src/shared/model/document.js'
import type { EntityFile } from '../src/shared/model/entity.js'
import type { ManuscriptFile } from '../src/shared/model/manuscript.js'

let harness: Harness

test.afterEach(async () => {
  if (harness) await cleanup(harness)
})

async function editor() {
  const locator = harness.page.locator('.pub-sheet:visible .ProseMirror').first()
  await expect(locator).toBeVisible()
  return locator
}

async function setStyle(styleId: string): Promise<void> {
  await harness.page.locator('select[title="Paragraph style"]:visible').selectOption(styleId)
}

async function currentStyle(): Promise<string> {
  return harness.page.locator('select[title="Paragraph style"]:visible').inputValue()
}

test('a numbered heading style shows its number on screen and again after reopening the project', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await harness.page.evaluate(() =>
    window.__pub.project.getState().updateManifest((manifest) => ({
      ...manifest,
      styles: manifest.styles.map((style) =>
        style.id === 'heading-1'
          ? { ...style, numbering: { format: 'decimal', startAt: 1, levelText: '%1. ' } }
          : style
      )
    }))
  )
  await createDocument(harness.page, 'chapter-01.pubdoc')

  const el = await editor()
  await el.click()
  await harness.page.keyboard.type('Introduction')
  await setStyle('heading-1')

  const numbers = harness.page.locator('.pub-heading-number')
  await expect(numbers).toHaveCount(1)
  await expect(numbers.first()).toHaveText('1. ')

  await harness.page.keyboard.press('End')
  await harness.page.keyboard.press('Enter')
  await harness.page.keyboard.type('Method')
  await setStyle('heading-1')
  await expect(numbers).toHaveCount(2)
  await expect(numbers.nth(1)).toHaveText('2. ')

  await harness.page.evaluate(() => window.__pub.documents.getState().flushAll())
  const { projectDir, userDataDir } = harness
  await harness.app.close()

  harness = await launch({ projectDir, userDataDir })
  await openProject(harness.page, projectDir)
  await harness.page.evaluate(async (target) => {
    const documents = window.__pub.documents.getState()
    const id = await documents.openPath(target)
    const state = window.__pub.documents.getState().docs[id!]!
    window.__pub.layout.getState().openEditor(id!, state.path, state.title)
  }, 'chapter-01.pubdoc')

  const reopened = harness.page.locator('.pub-heading-number')
  await expect(reopened).toHaveCount(2)
  await expect(reopened.first()).toHaveText('1. ')
  await expect(reopened.nth(1)).toHaveText('2. ')
})

test('a project with custom entity kinds opens the right panel and saves a record under that kind', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await harness.page.evaluate(() =>
    window.__pub.project.getState().updateManifest((manifest) => ({
      ...manifest,
      entityKinds: [
        { id: 'interviewee', label: 'interviewee', labelPlural: 'Interviewees', suggestedFields: ['Role'] }
      ]
    }))
  )

  await harness.page.evaluate(() =>
    window.__pub.layout
      .getState()
      .showPanel('records', 'Interviewees', { panelId: 'interviewee', params: { kind: 'interviewee' } })
  )
  await expect(harness.page.locator('span.flex-1', { hasText: 'Interviewees' })).toBeVisible()

  await harness.page.getByRole('button', { name: 'New interviewee' }).click()
  await expect(harness.page.getByTestId('prompt-dialog')).toBeVisible()
  await harness.page.getByTestId('prompt-input').fill('Dr. Osei')
  await harness.page.getByTestId('prompt-confirm').click()

  await harness.page.evaluate(() => window.__pub.entities.getState().flush())
  await waitFor(async () => {
    const file = await readJson<EntityFile>(path.join(harness.projectDir, '.thepub', 'entities.json'))
    return file.entities.some((entity) => entity.name === 'Dr. Osei' && entity.kind === 'interviewee')
  }, 'the interviewee record to be written under its own kind')
})

test('the pre-Phase-6 "characters" panel id still renders a working panel', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  // No `panelId`/`params` — exactly how a restored layout from an older build
  // would ask dockview for this panel, by its old component id alone.
  await harness.page.evaluate(() => window.__pub.layout.getState().showPanel('characters', 'Characters'))
  await expect(harness.page.locator('span.flex-1', { hasText: 'Characters' })).toBeVisible()
  await expect(harness.page.getByRole('button', { name: 'New character' })).toBeVisible()
})

test('a misplaced front-matter part is warned about, and "Move to front" fixes it', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')
  await harness.page.evaluate(async () => {
    const manuscript = window.__pub.manuscript.getState()
    await manuscript.addDocuments(['chapter-01.pubdoc'], null)
    await manuscript.createPart('Dedication', 'front')
  })

  await harness.page.evaluate(() => window.__pub.runCommand('panel.manuscript'))
  const warning = harness.page.getByTestId('manuscript-front-matter-warning')
  await expect(warning).toBeVisible()
  await expect(warning).toContainText('Dedication')

  await harness.page.getByTestId('manuscript-move-front-matter').click()
  await expect(warning).toHaveCount(0)

  await waitFor(async () => {
    const file = await readJson<ManuscriptFile>(path.join(harness.projectDir, '.thepub', 'manuscript.json'))
    const root = file.nodes.filter((node) => node.parentId === null).sort((a, b) => a.order - b.order)
    return root[0]?.title === 'Dedication'
  }, 'Dedication to sort to the front')
})

test('Tab cycles a screenplay element, and Enter still applies the next-element chain', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await harness.page.evaluate(() =>
    window.__pub.project.getState().updateManifest((manifest) => ({
      ...manifest,
      styles: [
        { id: 'scene-heading', name: 'Scene Heading', builtin: true, nextStyle: 'action', cycleStyle: 'action', text: {}, paragraph: {} },
        { id: 'action', name: 'Action', builtin: true, nextStyle: 'action', cycleStyle: 'character-cue', text: {}, paragraph: {} },
        { id: 'character-cue', name: 'Character', builtin: true, nextStyle: 'dialogue', cycleStyle: 'parenthetical', text: {}, paragraph: {} },
        { id: 'parenthetical', name: 'Parenthetical', builtin: true, nextStyle: 'dialogue', cycleStyle: 'dialogue', text: {}, paragraph: {} },
        { id: 'dialogue', name: 'Dialogue', builtin: true, nextStyle: 'character-cue', cycleStyle: 'transition', text: {}, paragraph: {} },
        { id: 'transition', name: 'Transition', builtin: true, nextStyle: 'scene-heading', cycleStyle: 'scene-heading', text: {}, paragraph: {} }
      ]
    }))
  )
  await createDocument(harness.page, 'script.pubdoc')

  const el = await editor()
  await el.click()
  await harness.page.keyboard.type('INT. KITCHEN - NIGHT')
  await setStyle('scene-heading')
  await harness.page.keyboard.press('End')
  await harness.page.keyboard.press('Enter')
  // Enter's "what comes next" chain: Scene Heading -> Action.
  await expect.poll(currentStyle).toBe('action')

  await harness.page.keyboard.type('Rain against the window.')
  await harness.page.keyboard.press('End')
  await harness.page.keyboard.press('Enter')
  await harness.page.keyboard.type('MARA')
  await setStyle('action')
  // Tab's ring: Action -> Character, independent of Enter's chain.
  await harness.page.keyboard.press('Tab')
  await expect.poll(currentStyle).toBe('character-cue')

  await harness.page.keyboard.press('End')
  await harness.page.keyboard.press('Enter')
  // Enter's chain again: Character -> Dialogue.
  await expect.poll(currentStyle).toBe('dialogue')
  await harness.page.keyboard.type('I thought you left already.')

  await harness.page.evaluate(() => window.__pub.documents.getState().flushAll())
  const saved = await readJson<PubDocument>(path.join(harness.projectDir, 'script.pubdoc'))
  const styleIds = (saved.content.content ?? []).map((node) => (node.attrs as { styleId?: string })?.styleId)
  expect(styleIds).toEqual(['scene-heading', 'action', 'character-cue', 'dialogue'])
})

test('a script exports to .fountain and reads back into a new document with the same shape', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await harness.page.evaluate(() =>
    window.__pub.project.getState().updateManifest((manifest) => ({
      ...manifest,
      styles: [
        { id: 'scene-heading', name: 'Scene Heading', builtin: true, text: {}, paragraph: {} },
        { id: 'action', name: 'Action', builtin: true, text: {}, paragraph: {} },
        { id: 'character-cue', name: 'Character', builtin: true, text: {}, paragraph: {} },
        { id: 'dialogue', name: 'Dialogue', builtin: true, text: {}, paragraph: {} }
      ]
    }))
  )
  await createDocument(harness.page, 'script.pubdoc')
  const el = await editor()
  await el.click()
  await harness.page.keyboard.type('INT. KITCHEN - NIGHT')
  await setStyle('scene-heading')
  await harness.page.keyboard.press('End')
  await harness.page.keyboard.press('Enter')
  await harness.page.keyboard.type('Rain against the window.')
  await setStyle('action')
  await harness.page.evaluate(() => window.__pub.documents.getState().flushAll())

  const fountainFile = path.join(harness.projectDir, 'script.fountain')
  const exported = await harness.page.evaluate(
    ({ file }) => window.pub.invoke('fountain:export', { path: 'script.pubdoc', file }),
    { file: fountainFile }
  )
  expect(exported).toMatchObject({ ok: true })

  const text = await fs.readFile(fountainFile, 'utf8')
  expect(text).toContain('INT. KITCHEN - NIGHT')
  expect(text).toContain('Rain against the window.')

  const imported = await harness.page.evaluate(
    ({ files }) => window.pub.invoke('fountain:import', { files, targetDir: '' }),
    { files: [fountainFile] }
  )
  expect(imported.imported).toHaveLength(1)

  const reimported = await readJson<PubDocument>(path.join(harness.projectDir, imported.imported[0]!.path))
  const texts = (reimported.content.content ?? []).map((node) =>
    (node.content ?? []).map((run) => (run as { text?: string }).text ?? '').join('')
  )
  expect(texts).toEqual(['INT. KITCHEN - NIGHT', 'Rain against the window.'])
})
