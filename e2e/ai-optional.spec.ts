import { test, expect } from '@playwright/test'
import path from 'node:path'
import { launch, openProject, cleanup, readJson, waitFor, type Harness } from './helpers.js'
import type { ChatFile } from '../src/shared/model/ai.js'
import type { LlmStatus } from '../src/shared/model/llm.js'

let harness: Harness

test.afterEach(async () => {
  if (harness) await cleanup(harness)
})

async function setAiEnabled(enabled: boolean): Promise<void> {
  await harness.page.evaluate(
    (value) => window.pub.invoke('app:setAiEnabled', { enabled: value }),
    enabled
  )
}

function commandIds(): Promise<string[]> {
  // The palette and the native menu are built from one registry, so what is in
  // it is what is reachable by either.
  return harness.page.evaluate(() => window.__pub.listCommands().map((command) => command.id))
}

test('turning AI off removes its panel and its command, and turning it back on restores the chats', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)

  // A conversation exists before the switch is touched, so this proves the
  // switch hides rather than deletes.
  await harness.page.evaluate(() => window.__pub.chats.getState().createChat('Kept'))
  await waitFor(
    async () =>
      (await readJson<ChatFile>(path.join(harness.projectDir, '.thepub', 'chats.json'))).chats
        .length === 1,
    'the chat to be written'
  )

  await harness.page.evaluate(() => window.__pub.layout.getState().showPanel('ai', 'AI'))
  expect(await commandIds()).toContain('panel.ai')

  await setAiEnabled(false)

  // Removed from the registry rather than left in it refusing: a greyed-out
  // "Ask AI" is still an AI product.
  await waitFor(async () => !(await commandIds()).includes('panel.ai'), 'the AI command to go')
  await expect(harness.page.getByTestId('chat-input')).toHaveCount(0)

  // And it stays gone across a restart, because the setting is the person's.
  const { projectDir, userDataDir } = harness
  await harness.app.close()
  harness = await launch({ projectDir, userDataDir })
  await openProject(harness.page, projectDir)

  expect(await commandIds()).not.toContain('panel.ai')
  await expect(harness.page.getByTestId('chat-input')).toHaveCount(0)

  // Nothing was deleted, so the conversation is still on disk.
  const file = await readJson<ChatFile>(path.join(projectDir, '.thepub', 'chats.json'))
  expect(file.chats.map((chat) => chat.title)).toEqual(['Kept'])

  await setAiEnabled(true)
  await waitFor(async () => (await commandIds()).includes('panel.ai'), 'the AI command to return')
  await harness.page.evaluate(() => window.__pub.chats.getState().load())
  const titles = await harness.page.evaluate(() =>
    window.__pub.chats.getState().chats.map((chat) => chat.title)
  )
  expect(titles).toEqual(['Kept'])
})

test('sending is refused while AI is off, even by a caller that bypasses the UI', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)

  const chat = await harness.page.evaluate(() => window.__pub.chats.getState().createChat())
  await setAiEnabled(false)

  const error = await harness.page.evaluate(async (id) => {
    try {
      await window.pub.invoke('ai:send', { chatId: id, text: 'Hello', context: '' })
      return null
    } catch (thrown) {
      return String(thrown)
    }
  }, chat!.id)

  // Defence in depth: the UI makes this unreachable, so getting here at all
  // means something bypassed it.
  expect(error).toContain('turned off')
})

test('embedded models report their state without a runtime present', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)

  const status = await harness.page.evaluate(() => window.pub.invoke('llm:status', {}))

  // A checkout with no `llama-server` is a supported state, not a broken one:
  // the app says so and every other provider carries on working.
  expect(status.runtimeAvailable).toBe(false)
  expect(status.engine.state).toBe('stopped')
  expect(status.totalMemoryBytes).toBeGreaterThan(0)
  // Every catalogue variant is accounted for, each with a verdict for this
  // machine — which is what lets the manager offer a small model where it
  // refuses a large one.
  expect(status.variants.length).toBeGreaterThan(0)
  expect(status.variants.every((variant: LlmStatus['variants'][number]) => variant.state === 'absent')).toBe(true)
})

test('an embedded model that is not downloaded says so rather than starting a download', async () => {
  harness = await launch()
  await openProject(harness.page, harness.projectDir)

  await harness.page.evaluate(() =>
    window.__pub.chats.getState().saveSettings({
      provider: 'embedded',
      model: 'bonsai-4b',
      baseUrl: '',
      temperature: 0.7,
      maxTokens: 512,
      systemPrompt: '',
      agent: false
    })
  )
  const chat = await harness.page.evaluate(() => window.__pub.chats.getState().createChat())

  const error = await harness.page.evaluate(async (id) => {
    try {
      await window.pub.invoke('ai:send', { chatId: id, text: 'Hello', context: '' })
      return null
    } catch (thrown) {
      return String(thrown)
    }
  }, chat!.id)

  // Pressing send is never what begins a multi-gigabyte transfer.
  expect(error).toBeTruthy()
  const status = await harness.page.evaluate(() => window.pub.invoke('llm:status', {}))
  expect(status.variants.every((variant: LlmStatus['variants'][number]) => variant.state === 'absent')).toBe(true)
})
