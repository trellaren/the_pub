import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { launch, openProject, createDocument, cleanup, waitFor, type Harness } from './helpers.js'

let harness: Harness

test.afterEach(async () => {
  if (harness) await cleanup(harness)
})

const EDITOR = '.pub-sheet:visible .ProseMirror'

async function typeAndSelect(text: string): Promise<void> {
  const editor = harness.page.locator(EDITOR)
  await editor.click()
  await harness.page.keyboard.type(text)
  await expect(editor).toContainText(text)
  await editor.press('Control+a')
}

test('the toolbar takes a size and a face that are not on its lists', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')
  await typeAndSelect('The harbour was quiet.')

  /*
   * 13.5 is on no preset list, and that is the point: the pickers used to be
   * <select>s, which made thirteen sizes and seven faces the entire offer.
   */
  await harness.page.getByTestId('toolbar-size').fill('13.5')
  await harness.page.getByTestId('toolbar-size').press('Enter')
  await expect(harness.page.locator(`${EDITOR} span[style*="font-size: 13.5pt"]`)).toBeVisible()

  await harness.page.locator(EDITOR).press('Control+a')
  await harness.page.getByTestId('toolbar-font').fill('Optima')
  await harness.page.getByTestId('toolbar-font').press('Enter')
  await expect(harness.page.locator(`${EDITOR} span[style*="Optima"]`)).toBeVisible()
})

test('a nonsense size is refused rather than applied', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')
  await typeAndSelect('Hello.')

  await harness.page.getByTestId('toolbar-size').fill('0')
  await harness.page.getByTestId('toolbar-size').press('Enter')
  await expect(harness.page.locator(`${EDITOR} span[style*="font-size"]`)).toHaveCount(0)
})

test('an imported font reaches the page, the manifest and the next session', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)

  // Any bytes serve: nothing below asserts glyph rendering, only that the file
  // is copied into the project, indexed, declared as a @font-face, and still
  // all three after a reopen. The name the family is derived from is the test.
  const source = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'pub-font-src-')), 'Libre_Test-Font.ttf')
  await fs.writeFile(source, Buffer.from('not-really-a-font'))

  const font = await harness.page.evaluate(async (file) => {
    const result = await window.pub.invoke('fonts:import', { file })
    const state = window.__pub.project.getState()
    await state.updateManifest((manifest) => ({
      ...manifest,
      fonts: [...((manifest as { fonts?: unknown[] }).fonts ?? []), result.font]
    }) as typeof manifest)
    return result.font
  }, source)

  // The filename, cleaned, is the family.
  expect(font.family).toBe('Libre Test Font')
  expect(font.file.startsWith('.thepub/fonts/')).toBe(true)

  // The file was copied into the project through the VFS.
  const copied = await fs.readFile(path.join(harness.projectDir, font.file))
  expect(copied.toString()).toBe('not-really-a-font')

  // Declared in the window as a real @font-face over the asset protocol.
  await waitFor(
    async () =>
      (await harness.page.evaluate(
        () => document.getElementById('pub-project-fonts')?.textContent ?? ''
      )).includes('Libre Test Font'),
    'the @font-face sheet to include the imported family'
  )
  const css = await harness.page.evaluate(() => document.getElementById('pub-project-fonts')!.textContent!)
  expect(css).toContain('pub-asset://')

  // Offered where fonts are chosen.
  await harness.page.evaluate(() => window.__pub.layout.getState().showPanel('styles', 'Styles'))
  await expect(harness.page.getByTestId('project-font')).toContainText('Libre Test Font')

  // And still all of that after the project closes and reopens.
  const { projectDir, userDataDir } = harness
  await harness.app.close()
  harness = await launch({ projectDir, userDataDir })
  await openProject(harness.page, projectDir)

  await waitFor(
    async () =>
      (await harness.page.evaluate(
        () => document.getElementById('pub-project-fonts')?.textContent ?? ''
      )).includes('Libre Test Font'),
    'the imported font to load with the reopened project'
  )
})

test('deleting a font refuses paths outside the fonts directory', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')

  // `fonts:delete` takes a project-relative path from the renderer, so it must
  // not be usable as a generic delete with a friendlier name.
  const refused = await harness.page.evaluate(async () => {
    try {
      await window.pub.invoke('fonts:delete', { file: 'chapter-01.pubdoc' })
      return null
    } catch (error) {
      return String(error)
    }
  })
  expect(refused).toContain('not an imported font')
  await expect
    .poll(async () => fs.access(path.join(harness.projectDir, 'chapter-01.pubdoc')).then(() => true))
    .toBe(true)
})
