import { test, expect } from '@playwright/test'
import { launch, openProject, createDocument, cleanup, type Harness } from './helpers.js'

let harness: Harness

test.afterEach(async () => {
  if (harness) await cleanup(harness)
})

test('quick open with no project offers to open one', async () => {
  harness = await launch()
  await harness.page.evaluate(() => window.__pub.runCommand('palette.quickOpen'))

  const option = harness.page.getByRole('option', { name: 'Open a project…' })
  await expect(option).toBeVisible()
  await expect(option).toHaveAttribute('aria-selected', 'true')
})

test('quick open finds a document by its file name, and focus goes back where it was', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)
  await createDocument(harness.page, 'lighthouse-keeper.pubdoc')
  await createDocument(harness.page, 'harbour.pubdoc')

  const opener = harness.page.getByTestId('title-search')
  await opener.focus()
  await harness.page.evaluate(() => window.__pub.runCommand('palette.quickOpen'))

  const input = harness.page.getByRole('combobox', { name: 'Go to document' })
  await expect(input).toBeFocused()
  await input.fill('lighthouse')
  const options = harness.page.getByRole('listbox').getByRole('option')
  await expect(options).toHaveCount(1)
  await expect(options.first()).toContainText('lighthouse-keeper.pubdoc')
  await expect(input).toHaveAttribute('aria-activedescendant', /.+/)

  await input.press('Escape')
  await expect(input).toHaveCount(0)
  await expect(opener).toBeFocused()
})
