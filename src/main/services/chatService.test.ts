import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { ChatService, titleFrom } from './chatService.js'
import { LocalAdapter } from '../vfs/localAdapter.js'
import {
  aiSettingsSchema,
  chatSchema,
  resolveSettings,
  type ChatMessage
} from '../../shared/model/ai.js'
import { CHATS_FILE } from '../../shared/constants.js'

let root: string
let adapter: LocalAdapter
let chats: ChatService

function message(role: 'user' | 'assistant', text: string): ChatMessage {
  return { id: `${role}-${text.slice(0, 4)}`, role, text, model: '', created: '2026-01-01T00:00:00.000Z' }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-chats-'))
  adapter = new LocalAdapter(root)
  chats = new ChatService(adapter)
  await chats.load()
})

afterEach(async () => {
  await adapter.dispose()
  await fs.rm(root, { recursive: true, force: true })
})

describe('ChatService', () => {
  it('starts empty with default settings', () => {
    const file = chats.snapshot()
    expect(file.chats).toEqual([])
    expect(file.settings.provider).toBe('anthropic')
  })

  it('writes chats and messages through to disk', async () => {
    const chat = await chats.create('First')
    await chats.append(chat.id, message('user', 'Read this scene.'))
    await chats.append(chat.id, message('assistant', 'It opens well.'))

    const reloaded = new ChatService(adapter)
    const [stored] = (await reloaded.load()).chats
    expect(stored!.messages.map((item) => item.role)).toEqual(['user', 'assistant'])
  })

  it('names an untitled chat after the first thing said in it', async () => {
    const chat = await chats.create('New chat')
    const updated = await chats.append(chat.id, message('user', 'What is wrong with chapter two?'))
    expect(updated!.title).toBe('What is wrong with chapter two?')
  })

  it('does not rename a chat on later messages', async () => {
    const chat = await chats.create('New chat')
    await chats.append(chat.id, message('user', 'First question'))
    const after = await chats.append(chat.id, message('user', 'Second question'))
    expect(after!.title).toBe('First question')
  })

  it('ignores a message for a chat that is gone', async () => {
    expect(await chats.append('nope', message('user', 'Hello'))).toBeNull()
  })

  it('saves project-wide settings', async () => {
    await chats.saveSettings(aiSettingsSchema.parse({ provider: 'openai', model: 'gpt-4o-mini' }))
    const reloaded = new ChatService(adapter)
    const file = await reloaded.load()
    expect(file.settings).toMatchObject({ provider: 'openai', model: 'gpt-4o-mini' })
  })

  it('falls back to empty on a corrupt file, keeping the original', async () => {
    await chats.create('First')
    await fs.writeFile(path.join(root, CHATS_FILE), 'nonsense', 'utf8')
    const reloaded = new ChatService(adapter)
    expect((await reloaded.load()).chats).toEqual([])
    const kept = (await fs.readdir(path.join(root, '.thepub'))).filter((name) =>
      name.includes('chats.json.corrupt-')
    )
    expect(kept).toHaveLength(1)
  })

  it('hands out copies rather than its cache', async () => {
    const chat = await chats.create('First')
    chats.snapshot().chats[0]!.title = 'Tampered'
    expect(chats.get(chat.id)?.title).toBe('First')
  })
})

describe('titleFrom', () => {
  it('takes the first line', () => {
    expect(titleFrom('Why does this scene drag?\nMore detail')).toBe('Why does this scene drag?')
  })

  it('truncates a long line', () => {
    expect(titleFrom('x'.repeat(200)).length).toBeLessThanOrEqual(60)
    expect(titleFrom('x'.repeat(200)).endsWith('…')).toBe(true)
  })

  it('has something to say about an empty message', () => {
    expect(titleFrom('   ')).toBe('New chat')
  })
})

describe('per-chat overrides', () => {
  it('leaves an untouched chat with no overrides at all', () => {
    // `aiSettingsSchema.partial()` looks equivalent and is not: it fills in
    // every default, so an untouched chat would silently override the
    // project's provider with the schema default.
    const chat = chatSchema.parse({
      id: 'c1',
      title: 'New chat',
      created: 'x',
      modified: 'x'
    })
    expect(chat.settings).toEqual({})
  })

  it('lets the project settings through when a chat overrides nothing', async () => {
    const project = aiSettingsSchema.parse({ provider: 'lmstudio', baseUrl: 'http://localhost:1234' })
    const chat = chatSchema.parse({ id: 'c1', title: 'x', created: 'x', modified: 'x' })
    const resolved = resolveSettings(project, chat.settings)
    expect(resolved.provider).toBe('lmstudio')
    expect(resolved.baseUrl).toBe('http://localhost:1234')
  })

  it('keeps an override the author did set', () => {
    const project = aiSettingsSchema.parse({ provider: 'lmstudio' })
    const chat = chatSchema.parse({
      id: 'c1',
      title: 'x',
      created: 'x',
      modified: 'x',
      settings: { provider: 'openai' }
    })
    expect(resolveSettings(project, chat.settings).provider).toBe('openai')
  })
})

describe('resolveSettings', () => {
  const base = aiSettingsSchema.parse({})

  it('fills in the provider defaults', () => {
    const resolved = resolveSettings(base)
    expect(resolved.model).toBe('claude-sonnet-4-5')
    expect(resolved.baseUrl).toBe('https://api.anthropic.com')
  })

  it('lets a chat override the project', () => {
    const resolved = resolveSettings(base, { provider: 'lmstudio' })
    expect(resolved.provider).toBe('lmstudio')
    // The model must follow the provider, not be inherited from the other one.
    expect(resolved.model).toBe('local-model')
  })

  it('ignores blank overrides rather than erasing a default', () => {
    expect(resolveSettings(base, { model: '', baseUrl: undefined }).model).toBe('claude-sonnet-4-5')
  })

  it('trims a trailing slash off a base url', () => {
    expect(resolveSettings(base, { baseUrl: 'http://localhost:1234//' }).baseUrl).toBe(
      'http://localhost:1234'
    )
  })
})
