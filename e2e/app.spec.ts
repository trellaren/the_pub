import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { launch, openProject, createDocument, cleanup, readJson, waitFor, type Harness } from './helpers.js'
import type { PubDocument } from '../src/shared/model/document.js'
import type { LayoutFile } from '../src/shared/model/layout.js'
import type { SearchHit } from '../src/shared/model/search.js'

let harness: Harness

test.afterEach(async () => {
  if (harness) await cleanup(harness)
})

test('opening a folder scaffolds a project', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)

  const manifest = await readJson<{ name: string; styles: { id: string }[] }>(
    path.join(harness.projectDir, '.thepub', 'project.json')
  )
  expect(manifest.name).toBe(path.basename(harness.projectDir))
  expect(manifest.styles.map((style) => style.id)).toContain('body')
})

test('typing autosaves to disk and the file stays valid JSON', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')

  const editor = harness.page.locator('.pub-sheet:visible .ProseMirror')
  await expect(editor).toBeVisible()
  await editor.click()
  await harness.page.keyboard.type('The storm broke over Ashfall at dusk.')

  const file = path.join(harness.projectDir, 'chapter-01.pubdoc')
  await waitFor(async () => {
    const doc = await readJson<PubDocument>(file)
    return JSON.stringify(doc.content).includes('The storm broke over Ashfall')
  }, 'autosave to write the typed text')

  // Atomic writes mean the file is never observed half-written.
  const saved = await readJson<PubDocument>(file)
  expect(saved.docId).toBeTruthy()
  expect(saved.wordCount).toBeGreaterThan(0)
})

test('global search finds typed text and reports the right block', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')

  const editor = harness.page.locator('.pub-sheet:visible .ProseMirror')
  await editor.click()
  await harness.page.keyboard.type('A quiet morning in the valley.')
  await harness.page.keyboard.press('Enter')
  await harness.page.keyboard.type('Then the storm broke.')

  await harness.page.evaluate(() => window.__pub.documents.getState().flushAll())

  await waitFor(async () => {
    const hits = await harness.page.evaluate(() =>
      window.pub.invoke('search:query', {
        text: 'storm',
        limit: 20,
        matchCase: false,
        wholeWord: false
      })
    )
    const content = (hits as SearchHit[]).filter((hit) => hit.kind === 'content')
    return content.length > 0 && content[0]!.blockIndex === 1
  }, 'search to index the new text and locate it in the second block')
})

test('a torn-off panel opens a real window that keeps its own dock', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')

  const windowsBefore = harness.app.windows().length
  // Clicked rather than called: browsers only allow `window.open` during a user
  // gesture, so driving this from script would be blocked.
  await harness.page.locator('[data-testid="popout-group"]').last().click()

  await waitFor(() => harness.app.windows().length > windowsBefore, 'the popout window to open')

  // Dockview records popouts in the layout it serializes, which is what lets
  // them come back on restart.
  await waitFor(async () => {
    const layout = await harness.page.evaluate(() => {
      const api = window.__pub.layout.getState().api
      return api ? JSON.stringify(api.toJSON()) : null
    })
    return Boolean(layout && JSON.parse(layout).popoutGroups?.length > 0)
  }, 'the popout to appear in the serialized layout')
})

test('layout and content are restored when the project is reopened', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')

  const editor = harness.page.locator('.pub-sheet:visible .ProseMirror')
  await editor.click()
  await harness.page.keyboard.type('Persisted across restarts.')
  await harness.page.evaluate(() => window.__pub.documents.getState().flushAll())

  const layoutFile = path.join(harness.projectDir, '.thepub', 'layouts.json')
  await waitFor(async () => {
    const layout = await readJson<LayoutFile>(layoutFile)
    return layout.lastLayout !== null
  }, 'the layout to be persisted')

  const { projectDir, userDataDir } = harness
  await harness.app.close()

  harness = await launch({ projectDir, userDataDir })
  await openProject(harness.page, projectDir)

  // The editor panel comes back from the saved layout, and finds its document
  // by id rather than by the path that happened to be stored.
  await waitFor(async () => {
    const ids = await harness.page.evaluate(
      () => window.__pub.layout.getState().api?.panels.map((panel) => panel.id) ?? []
    )
    return ids.some((id) => id.startsWith('editor:'))
  }, 'the editor panel to be restored')

  await expect(harness.page.locator('.pub-sheet:visible .ProseMirror')).toContainText('Persisted across restarts.')
})

/*
 * The reported bug: "adding a new view should not resize all of the panels".
 * Every singleton panel asked for a bare left position, which dockview reads as
 * an absolute one and answers by inserting a new column at the grid root — so
 * opening anything shrank everything and pushed the Explorer inward. No test
 * had ever looked at a panel's width or which group it joined.
 */
test('opening panels leaves the ones already on screen the size they were', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')

  const widthOf = async (panelId: string): Promise<number> =>
    harness.page.evaluate(
      (id) => window.__pub.layout.getState().api?.getPanel(id)?.group.api.width ?? 0,
      panelId
    )
  const groupOf = async (panelId: string): Promise<string> =>
    harness.page.evaluate(
      (id) => window.__pub.layout.getState().api?.getPanel(id)?.group.id ?? '',
      panelId
    )

  const explorerBefore = await widthOf('explorer')
  const editorId = await harness.page.evaluate(
    () =>
      window.__pub.layout
        .getState()
        .api?.panels.find((panel) => panel.id.startsWith('editor:'))?.id ?? ''
  )
  const editorBefore = await widthOf(editorId)
  expect(explorerBefore).toBeGreaterThan(0)
  expect(editorBefore).toBeGreaterThan(0)

  const editorGroup = await groupOf(editorId)

  await harness.page.evaluate(() => window.__pub.runCommand('panel.ai'))
  await expect(harness.page.getByTestId('chat-thread')).toBeVisible()
  await harness.page.evaluate(() => window.__pub.runCommand('panel.storyboard'))
  await harness.page.evaluate(() => window.__pub.runCommand('panel.styles'))

  // Nothing was carved out of the window, so nothing had to give room up:
  // every panel arrived as a tab in a group that was already there.
  expect(await widthOf('explorer')).toBe(explorerBefore)
  expect(await widthOf(editorId)).toBe(editorBefore)

  // Working panels open over the documents, where there is room to use them,
  // and are found on a tab you can drag elsewhere if you would rather.
  expect(await groupOf('ai')).toBe(editorGroup)
  expect(await groupOf('storyboard')).toBe(editorGroup)

  // Consulting panels go to the sidebar, which is a different group.
  expect(await groupOf('styles')).toBe(await groupOf('explorer'))
  expect(await groupOf('styles')).not.toBe(editorGroup)
})

test('a document restored by id survives being renamed on disk', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'chapter-01.pubdoc')

  const editor = harness.page.locator('.pub-sheet:visible .ProseMirror')
  await editor.click()
  await harness.page.keyboard.type('Chapter that moves.')
  await harness.page.evaluate(() => window.__pub.documents.getState().flushAll())

  await waitFor(async () => {
    const layout = await readJson<LayoutFile>(path.join(harness.projectDir, '.thepub', 'layouts.json'))
    return layout.lastLayout !== null
  }, 'the layout to be persisted')

  const { projectDir, userDataDir } = harness
  await harness.app.close()

  // Rename it while the app is closed — exactly what a writer reorganising
  // their folders in Finder would do.
  await fs.mkdir(path.join(projectDir, 'part-one'), { recursive: true })
  await fs.rename(
    path.join(projectDir, 'chapter-01.pubdoc'),
    path.join(projectDir, 'part-one', 'chapter-01.pubdoc')
  )

  harness = await launch({ projectDir, userDataDir })
  await openProject(harness.page, projectDir)

  await expect(harness.page.locator('.pub-sheet:visible .ProseMirror')).toContainText('Chapter that moves.', {
    timeout: 25_000
  })
})
