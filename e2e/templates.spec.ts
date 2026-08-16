import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { launch, cleanup, waitFor, readJson, type Harness } from './helpers.js'
import type { ProjectManifest } from '../src/shared/model/manifest.js'

/*
 * "New Project from Template…", driven through the real UI — see create.spec.ts
 * for why the hook is only ever used to open the app and read state back. The
 * one native surface in the flow, the folder-choose dialog, is stubbed on the
 * main process exactly as the manuscript compile tests stub `showSaveDialog`.
 */

let harness: Harness
let targetDir: string

test.afterEach(async () => {
  if (harness) await cleanup(harness)
  if (targetDir) await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {})
})

async function stubFolderChoice(dir: string): Promise<void> {
  await harness.app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [chosen]
    })) as typeof dialog.showOpenDialog
  }, dir)
}

test('creating a project from the built-in Novel template opens it with its styles', async () => {
  harness = await launch()
  targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-e2e-template-target-'))
  await stubFolderChoice(targetDir)

  await harness.page.getByTestId('open-new-project').click()
  await expect(harness.page.getByTestId('new-project-dialog')).toBeVisible()

  const novel = harness.page.getByTestId('template-builtin-novel')
  await expect(novel).toBeVisible()
  await novel.click()
  await harness.page.getByTestId('new-project-name').fill('My Great Novel')
  await harness.page.getByTestId('new-project-create').click()

  await expect(harness.page.getByTestId('new-project-dialog')).toBeHidden()
  await waitFor(
    async () => (await harness.page.evaluate(() => window.__pub.project.getState().project?.manifest.name)) === 'My Great Novel',
    'the new project to open'
  )

  const project = await harness.page.evaluate(() => window.__pub.project.getState().project)
  expect(project?.manifest.projectType).toBe('novel')
  expect(project?.manifest.styles.length).toBeGreaterThan(0)
  expect(project?.readOnly).toBe(false)

  // A fresh identity on disk, not the template's own.
  const manifest = await readJson<ProjectManifest>(path.join(targetDir, '.thepub', 'project.json'))
  expect(manifest.id).not.toBe('builtin-novel')
  expect(manifest.name).toBe('My Great Novel')

  // The still-open Welcome panel reads the new project straight from the
  // store, so its own re-render is the on-screen proof the window followed
  // the new project rather than merely resolving a promise underneath it.
  await expect(harness.page.getByTestId('welcome-project-root')).toContainText(path.basename(targetDir))
})

test('refuses to seed a folder that already holds a project', async () => {
  harness = await launch()
  targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-e2e-template-target-'))
  await fs.mkdir(path.join(targetDir, '.thepub'), { recursive: true })
  await fs.writeFile(
    path.join(targetDir, '.thepub', 'project.json'),
    JSON.stringify({
      formatVersion: 2,
      id: 'existing',
      name: 'Already Here',
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      projectType: 'novel',
      settings: {}
    })
  )
  await stubFolderChoice(targetDir)

  await harness.page.getByTestId('open-new-project').click()
  await harness.page.getByTestId('template-builtin-novel').click()
  await harness.page.getByTestId('new-project-name').fill('Should Not Land')
  await harness.page.getByTestId('new-project-create').click()

  await expect(harness.page.getByTestId('notice-error')).toContainText('already holds a project')
  // The dialog stays open — nothing was created, so there is nothing to open into.
  await expect(harness.page.getByTestId('new-project-dialog')).toBeVisible()

  const manifest = await readJson<ProjectManifest>(path.join(targetDir, '.thepub', 'project.json'))
  expect(manifest.name).toBe('Already Here')
})
