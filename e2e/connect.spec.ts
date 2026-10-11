import { test, expect } from '@playwright/test'
import { launch, cleanup, type Harness } from './helpers.js'

let harness: Harness

test.afterEach(async () => {
  if (harness) await cleanup(harness)
})

test('a failed test of a new server shows why, in red, and saves nothing', async () => {
  harness = await launch()
  const page = harness.page
  await page.getByTestId('open-connect').click()
  const dialog = page.getByTestId('connect-dialog')

  await page.getByTestId('connect-protocol').selectOption('ftp')
  await dialog.getByRole('spinbutton').fill('1')
  await page.getByTestId('connect-host').fill('127.0.0.1')
  await page.getByTestId('connect-user').fill('nobody')
  await dialog.getByRole('button', { name: 'Test the connection' }).click()

  const status = page.getByTestId('connect-status')
  await expect(status).toBeVisible({ timeout: 20_000 })
  await expect(status).toHaveClass(/text-danger/)
  await expect(status).not.toHaveText('Could not reach the server.')
  await expect(status).not.toContainText('Error invoking remote method')
  await expect(dialog.getByRole('button', { name: 'Forget this server' })).toHaveCount(0)
  await expect(dialog.locator('ul li')).toHaveCount(1)
})
