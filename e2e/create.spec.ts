import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { launch, openProject, cleanup, waitFor, type Harness } from './helpers.js'

/*
 * Creation flows, driven through the real UI.
 *
 * Every suite before this one created things by calling the zustand stores
 * through the `window.__pub` hook — and that habit is precisely how eight dead
 * create buttons shipped across ten phases with green tests. In this file the
 * hook opens the project and reads state back, and nothing else: the action
 * under test is always a real click or keystroke on the thing an author uses.
 */

let harness: Harness

test.afterEach(async () => {
  if (harness) await cleanup(harness)
})

async function showExplorer(): Promise<void> {
  await harness.page.evaluate(() => window.__pub.runCommand('panel.explorer'))
  await expect(harness.page.getByTestId('file-tree')).toBeVisible()
}

test('the Explorer’s ＋ button creates a document that opens in a tab', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await showExplorer()

  await harness.page.getByRole('button', { name: 'New document' }).click()
  const input = harness.page.getByTestId('file-tree').locator('input')
  await expect(input).toBeVisible()
  await input.fill('chapter-01.pubdoc')
  await input.press('Enter')

  await waitFor(
    async () =>
      await fs
        .stat(path.join(harness.projectDir, 'chapter-01.pubdoc'))
        .then(() => true)
        .catch(() => false),
    'the document to appear on disk'
  )
  await expect(harness.page.locator('.pub-sheet:visible .ProseMirror')).toBeVisible()
})

test('right-clicking a folder creates the document inside it', async () => {
  harness = await launch()
  await fs.mkdir(path.join(harness.projectDir, 'part-one'))
  await openProject(harness.page, harness.projectDir)
  await showExplorer()

  await harness.page.getByRole('treeitem', { name: 'part-one' }).click({ button: 'right' })
  await harness.page.getByRole('menuitem', { name: 'New Document' }).click()

  const input = harness.page.getByTestId('file-tree').locator('input')
  await input.fill('scene.pubdoc')
  await input.press('Enter')

  await waitFor(
    async () =>
      await fs
        .stat(path.join(harness.projectDir, 'part-one', 'scene.pubdoc'))
        .then(() => true)
        .catch(() => false),
    'the document to land inside the folder'
  )
})

test('right-clicking empty space creates at the project root', async () => {
  harness = await launch()
  await fs.mkdir(path.join(harness.projectDir, 'part-one'))
  await openProject(harness.page, harness.projectDir)
  await showExplorer()

  // The bottom of the tree is empty space; rows sit at the top.
  const tree = harness.page.getByTestId('file-tree')
  const box = (await tree.boundingBox())!
  await harness.page.mouse.click(box.x + box.width / 2, box.y + box.height - 10, { button: 'right' })
  await harness.page.getByRole('menuitem', { name: 'New Folder' }).click()

  const input = tree.locator('input')
  await input.fill('notes')
  await input.press('Enter')

  await waitFor(
    async () =>
      await fs
        .stat(path.join(harness.projectDir, 'notes'))
        .then((stat) => stat.isDirectory())
        .catch(() => false),
    'the folder to appear at the root'
  )
})

/*
 * The invisible-input bug: selecting a file whose parent row is off screen —
 * here, by collapsing its ancestor — used to set create-state that rendered
 * nowhere, so the ＋ click looked like it did nothing at all.
 */
test('creating under a collapsed branch expands it rather than doing nothing', async () => {
  harness = await launch()
  await fs.mkdir(path.join(harness.projectDir, 'outer', 'inner'), { recursive: true })
  await fs.writeFile(path.join(harness.projectDir, 'outer', 'inner', 'deep.pubdoc'), '{}')
  await openProject(harness.page, harness.projectDir)
  await showExplorer()

  // Open the branch and select the deep file, then collapse its ancestor from
  // the keyboard — Enter activates a row without selecting it, so the deep
  // file stays selected while its parent row leaves the tree entirely.
  await harness.page.getByRole('treeitem', { name: 'outer' }).click()
  await harness.page.getByRole('treeitem', { name: 'inner' }).click()
  await harness.page.getByRole('treeitem', { name: 'deep.pubdoc' }).click()
  await harness.page.getByRole('treeitem', { name: 'outer' }).focus()
  await harness.page.getByRole('treeitem', { name: 'outer' }).press('Enter')
  await expect(harness.page.getByRole('treeitem', { name: 'deep.pubdoc' })).toHaveCount(0)
  await expect(harness.page.getByRole('treeitem', { name: 'inner' })).toHaveCount(0)

  await harness.page.getByRole('button', { name: 'New document' }).click()

  const input = harness.page.getByTestId('file-tree').locator('input')
  await expect(input).toBeVisible()
  await input.fill('sibling.pubdoc')
  await input.press('Enter')

  await waitFor(
    async () =>
      await fs
        .stat(path.join(harness.projectDir, 'outer', 'inner', 'sibling.pubdoc'))
        .then(() => true)
        .catch(() => false),
    'the document to land beside the selected file'
  )
})

test('an unusable name keeps the input open and says why', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await showExplorer()

  await harness.page.getByRole('button', { name: 'New document' }).click()
  const input = harness.page.getByTestId('file-tree').locator('input')
  await input.fill('what?.pubdoc')
  await input.press('Enter')

  // The typing survives to be corrected; it does not vanish into a toast.
  await expect(harness.page.getByTestId('name-problem')).toBeVisible()
  await expect(input).toHaveValue('what?.pubdoc')
})

/*
 * The reported bug: `document.new` — the File menu, Ctrl+N and the palette all
 * dispatch this id — called window.prompt, which Electron does not implement,
 * and the rejection vanished. With the Explorer on screen the command routes
 * to its inline input, which is the same code the ＋ button runs.
 */
test('document.new reaches the Explorer’s inline input when it is showing', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await showExplorer()

  await harness.page.evaluate(() => window.__pub.runCommand('document.new'))

  const input = harness.page.getByTestId('file-tree').locator('input')
  await expect(input).toBeVisible()
  await input.fill('via-command.pubdoc')
  await input.press('Enter')

  await waitFor(
    async () =>
      await fs
        .stat(path.join(harness.projectDir, 'via-command.pubdoc'))
        .then(() => true)
        .catch(() => false),
    'the document to appear on disk'
  )
})

/*
 * Dockview keeps a stacked panel mounted when a sibling tab is active, so a
 * hidden Explorer would still claim the command and put its inline input
 * somewhere invisible — Ctrl+N doing nothing, all over again. Off screen, the
 * app-level dialog takes it instead.
 */
test('document.new falls back to the dialog when the Explorer is hidden', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await showExplorer()
  // Search shares the Explorer's group, so activating it hides the tree.
  await harness.page.evaluate(() => window.__pub.runCommand('panel.search'))
  await expect(harness.page.getByTestId('file-tree')).toBeHidden()

  await harness.page.evaluate(() => window.__pub.runCommand('document.new'))
  await expect(harness.page.getByTestId('prompt-dialog')).toBeVisible()

  await harness.page.getByTestId('prompt-input').fill('from-dialog.pubdoc')
  await harness.page.getByTestId('prompt-confirm').click()

  await waitFor(
    async () =>
      await fs
        .stat(path.join(harness.projectDir, 'from-dialog.pubdoc'))
        .then(() => true)
        .catch(() => false),
    'the document to appear on disk'
  )
})

test('the dialog refuses an unusable name inline', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await showExplorer()
  await harness.page.evaluate(() => window.__pub.runCommand('panel.search'))
  await expect(harness.page.getByTestId('file-tree')).toBeHidden()

  await harness.page.evaluate(() => window.__pub.runCommand('document.new'))
  // A reserved MS-DOS device name, refused on every platform for portability.
  await harness.page.getByTestId('prompt-input').fill('CON')

  await expect(harness.page.getByTestId('prompt-error')).toBeVisible()
  await expect(harness.page.getByTestId('prompt-confirm')).toBeDisabled()
})

/*
 * The other half of the pair in `sftp.spec.ts`, which asserts these two are
 * *absent* on a project served over SSH. Kept here so that hiding them
 * everywhere — which would look like a passing test over there — is caught.
 */
test('a local project offers the file manager and names the delete after the trash', async () => {
  harness = await launch()
  await fs.writeFile(path.join(harness.projectDir, 'chapter.pubdoc'), '{}')
  await openProject(harness.page, harness.projectDir)
  await showExplorer()

  await harness.page.getByRole('treeitem', { name: 'chapter.pubdoc' }).click({ button: 'right' })

  await expect(harness.page.getByRole('menuitem', { name: 'Reveal in File Manager' })).toBeVisible()
  await expect(harness.page.getByRole('menuitem', { name: 'Move to Trash' })).toBeVisible()
})
