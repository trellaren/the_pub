import { test, expect } from '@playwright/test'
import { launch, cleanup, type Harness } from './helpers.js'
import type { ConnectionProfile } from '../src/shared/model/connection.js'

let harness: Harness

test.afterEach(async () => {
  if (harness) await cleanup(harness)
})

/**
 * What can be proven about OneDrive without a Microsoft account.
 *
 * The parts that talk to Graph are covered by unit tests against a fake drive;
 * what is left — and what only the real app can show — is that a drive can be
 * saved, that nothing here can see a token, and that every way this is set up
 * wrongly says so in words rather than failing at the network an hour later.
 *
 * Nothing in this file signs in: that opens the person's browser, which is the
 * whole point of the design and is not something a test should do.
 */

const CLIENT_ID = '11111111-2222-3333-4444-555555555555'

async function saveDrive(patch: Record<string, unknown> = {}): Promise<string> {
  return harness.page.evaluate(async (profile) => {
    const saved = await window.pub.invoke('connections:save', {
      profile: {
        name: 'My drive',
        protocol: 'onedrive' as const,
        host: '',
        user: '',
        ...profile
      }
    })
    return (saved as { id: string }).id
  }, patch)
}

test('a drive is saved without a host, a user or a password', async () => {
  harness = await launch()
  const id = await saveDrive({ clientId: CLIENT_ID, remotePath: 'Documents/Novel' })

  const listed = await harness.page.evaluate(() => window.pub.invoke('connections:list', {}))
  const profile = (listed.connections as ConnectionProfile[]).find(
    (candidate) => candidate.id === id
  )!
  expect(profile.protocol).toBe('onedrive')
  expect(profile.clientId).toBe(CLIENT_ID)
  expect(profile.tenant).toBe('common')
  // Nobody has signed in, so there is no token — and there is nowhere in this
  // shape for one to be even after they do.
  expect(profile.hasSecret).toBe(false)
  expect(JSON.stringify(profile)).not.toContain('refresh')
})

test('testing a drive nobody has signed in to says to sign in', async () => {
  harness = await launch()
  const id = await saveDrive({ clientId: CLIENT_ID })

  const result = await harness.page.evaluate(
    (profileId) => window.pub.invoke('connections:test', { id: profileId }),
    id
  )
  // The alternative is a request to Graph with no token and a 401 an author
  // cannot act on.
  expect(result.ok).toBe(false)
  expect(result.message).toContain('Sign in to OneDrive')
})

test('signing in without an app registration says exactly what is missing', async () => {
  harness = await launch()
  const id = await saveDrive()

  const result = await harness.page.evaluate(
    (profileId) => window.pub.invoke('connections:signIn', { id: profileId }),
    id
  )
  // This must fail before a browser is opened, which is also why this test can
  // exist at all.
  expect(result.ok).toBe(false)
  expect(result.message).toContain('Application (client) ID')
  expect(result.account).toBe('')
})

test('opening a project on a drive with no app registration fails readably', async () => {
  harness = await launch()
  const id = await saveDrive()

  const error = await harness.page.evaluate(async (profileId) => {
    try {
      await window.pub.invoke('project:open', { uri: `onedrive://${profileId}` })
      return null
    } catch (thrown) {
      return String(thrown)
    }
  }, id)
  expect(error).toContain('Application (client) ID')
})

test('the connect dialog asks for an app registration instead of a password', async () => {
  harness = await launch()
  await harness.page.getByTestId('open-connect').click()
  await expect(harness.page.getByTestId('connect-dialog')).toBeVisible()

  await harness.page.getByTestId('connect-protocol').selectOption('onedrive')

  // A drive has no host, no user and no password to type — asking for them
  // would be asking for something that cannot exist.
  await expect(harness.page.getByTestId('connect-client-id')).toBeVisible()
  await expect(harness.page.getByTestId('connect-tenant')).toBeVisible()
  await expect(harness.page.getByTestId('connect-signin')).toBeVisible()
  await expect(harness.page.getByTestId('connect-host')).toBeHidden()
  await expect(harness.page.getByTestId('connect-secret')).toBeHidden()
  await expect(harness.page.getByTestId('connect-account')).toContainText('Not signed in')

  // Saving with the client id blank is refused where it is typed, rather than
  // at the browser handoff.
  await harness.page.getByTestId('connect-signin').click()
  await expect(harness.page.getByTestId('connect-status')).toContainText('Application (client) ID')
})
