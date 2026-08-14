import { ulid } from 'ulid'
import type { VfsAdapter } from '../vfs/types.js'
import {
  chatFileSchema,
  chatSchema,
  aiSettingsSchema,
  type Chat,
  type ChatFile,
  type ChatMessage,
  type AiSettings
} from '../../shared/model/ai.js'
import { CHATS_FILE, PUB_DIR, FORMAT_VERSION } from '../../shared/constants.js'

function emptyFile(): ChatFile {
  return { formatVersion: FORMAT_VERSION, chats: [], settings: aiSettingsSchema.parse({}) }
}

/**
 * Conversations, persisted to `.thepub/chats.json`.
 *
 * Chats live with the project rather than with the app because they are about
 * *this* manuscript — they quote it, and they are worth reading back months
 * later beside the chapter they discuss. API keys emphatically do not live
 * here; see AiKeyStore for why.
 */
export class ChatService {
  private cache: ChatFile = emptyFile()
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly adapter: VfsAdapter) {}

  async load(): Promise<ChatFile> {
    const existing = await this.adapter.stat(CHATS_FILE)
    if (!existing) {
      this.cache = emptyFile()
      return this.snapshot()
    }
    try {
      const raw = await this.adapter.readFile(CHATS_FILE)
      this.cache = chatFileSchema.parse(JSON.parse(raw.toString('utf8')))
    } catch {
      await this.adapter.rename(CHATS_FILE, `${CHATS_FILE}.corrupt-${Date.now()}`).catch(() => {})
      this.cache = emptyFile()
    }
    return this.snapshot()
  }

  snapshot(): ChatFile {
    return structuredClone(this.cache)
  }

  get(id: string): Chat | null {
    return this.cache.chats.find((chat) => chat.id === id) ?? null
  }

  settings(): AiSettings {
    return { ...this.cache.settings }
  }

  async saveSettings(settings: AiSettings): Promise<AiSettings> {
    this.cache.settings = aiSettingsSchema.parse(settings)
    await this.flush()
    return { ...this.cache.settings }
  }

  async create(title: string): Promise<Chat> {
    const now = new Date().toISOString()
    const chat = chatSchema.parse({ id: ulid(), title, created: now, modified: now })
    this.cache.chats = [...this.cache.chats, chat]
    await this.flush()
    return structuredClone(chat)
  }

  async save(incoming: Chat): Promise<Chat> {
    const existing = this.get(incoming.id)
    const chat = chatSchema.parse({
      ...incoming,
      created: existing?.created ?? incoming.created,
      modified: new Date().toISOString()
    })
    this.cache.chats = existing
      ? this.cache.chats.map((candidate) => (candidate.id === chat.id ? chat : candidate))
      : [...this.cache.chats, chat]
    await this.flush()
    return structuredClone(chat)
  }

  async remove(id: string): Promise<void> {
    this.cache.chats = this.cache.chats.filter((chat) => chat.id !== id)
    await this.flush()
  }

  /**
   * Append a message and, for the first thing the author ever says, name the
   * chat after it — an untitled list of conversations is unusable within a day.
   */
  async append(chatId: string, message: ChatMessage): Promise<Chat | null> {
    const chat = this.get(chatId)
    if (!chat) return null
    const titled =
      chat.messages.length === 0 && message.role === 'user'
        ? titleFrom(message.text)
        : chat.title
    return this.save({ ...chat, title: titled, messages: [...chat.messages, message] })
  }

  private async flush(): Promise<void> {
    const file: ChatFile = { ...this.cache, formatVersion: FORMAT_VERSION }
    this.queue = this.queue.then(async () => {
      await this.adapter.mkdir(PUB_DIR).catch(() => {})
      await this.adapter.writeFileAtomic(
        CHATS_FILE,
        Buffer.from(`${JSON.stringify(file, null, 2)}\n`, 'utf8')
      )
    })
    await this.queue
  }
}

export function titleFrom(text: string, max = 60): string {
  const firstLine = text.trim().split('\n')[0]?.trim() ?? ''
  if (!firstLine) return 'New chat'
  return firstLine.length > max ? `${firstLine.slice(0, max - 1).trimEnd()}…` : firstLine
}
