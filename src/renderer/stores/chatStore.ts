import { create } from 'zustand'
import type { Chat, ChatMessage, AiSettings, AiProviderId } from '@shared/model/ai.js'
import { invoke, attempt, on } from '@renderer/lib/ipc.js'

interface ChatStore {
  chats: Chat[]
  settings: AiSettings | null
  activeChatId: string | null
  /** The reply currently arriving, if any. */
  streaming: { requestId: string; chatId: string; text: string } | null
  keyStatus: { configured: AiProviderId[]; secureStorage: boolean }
  loaded: boolean
  load: () => Promise<void>
  setActive: (id: string | null) => void
  createChat: (title?: string) => Promise<Chat | null>
  deleteChat: (id: string) => Promise<void>
  saveSettings: (settings: AiSettings) => Promise<void>
  saveChat: (chat: Chat) => Promise<void>
  send: (chatId: string, text: string, context: string) => Promise<void>
  cancel: () => Promise<void>
  refreshKeys: () => Promise<void>
  setKey: (provider: AiProviderId, key: string) => Promise<string | null>
}

export const useChatStore = create<ChatStore>((set, get) => ({
  chats: [],
  settings: null,
  activeChatId: null,
  streaming: null,
  keyStatus: { configured: [], secureStorage: false },
  loaded: false,

  load: async () => {
    const file = await attempt(invoke('ai:list', {}), 'Could not load chats')
    if (!file) return
    set({
      chats: file.chats,
      settings: file.settings,
      loaded: true,
      activeChatId: get().activeChatId ?? file.chats[file.chats.length - 1]?.id ?? null
    })
    await get().refreshKeys()
  },

  setActive: (id) => set({ activeChatId: id }),

  createChat: async (title = 'New chat') => {
    const chat = await attempt(invoke('ai:createChat', { title }), 'Could not start a chat')
    if (!chat) return null
    set({ chats: [...get().chats, chat], activeChatId: chat.id })
    return chat
  },

  deleteChat: async (id) => {
    await attempt(invoke('ai:deleteChat', { id }), 'Could not delete the chat')
    const chats = get().chats.filter((chat) => chat.id !== id)
    set({ chats, activeChatId: get().activeChatId === id ? (chats.at(-1)?.id ?? null) : get().activeChatId })
  },

  saveSettings: async (settings) => {
    set({ settings })
    const saved = await attempt(invoke('ai:saveSettings', { settings }), 'Could not save AI settings')
    if (saved) set({ settings: saved })
  },

  saveChat: async (chat) => {
    set({ chats: get().chats.map((candidate) => (candidate.id === chat.id ? chat : candidate)) })
    await attempt(invoke('ai:saveChat', { chat }), 'Could not save the chat')
  },

  send: async (chatId, text, context) => {
    const started = await attempt(
      invoke('ai:send', { chatId, text, context }),
      'Could not send the message'
    )
    if (!started) return
    // Show what was sent immediately; the reply arrives as stream events.
    set({
      chats: get().chats.map((chat) =>
        chat.id === chatId ? { ...chat, messages: [...chat.messages, started.message] } : chat
      ),
      streaming: { requestId: started.requestId, chatId, text: '' }
    })
  },

  cancel: async () => {
    const streaming = get().streaming
    if (!streaming) return
    await invoke('ai:cancel', { requestId: streaming.requestId }).catch(() => {})
  },

  refreshKeys: async () => {
    const status = await invoke('ai:keyStatus', {}).catch(() => null)
    if (status) set({ keyStatus: status })
  },

  setKey: async (provider, key) => {
    const result = await invoke('ai:setKey', { provider, key }).catch(() => null)
    await get().refreshKeys()
    return result?.ok ? null : (result?.reason ?? 'Could not save the key')
  }
}))

/**
 * Subscribe to reply events.
 *
 * Deltas accumulate in `streaming` rather than in the chat itself, so a
 * half-arrived reply is never mistaken for a stored message — the completed
 * message that lands on `done` is the one main has also written to disk.
 */
export function listenForReplies(): () => void {
  return on('ai:stream', (event) => {
    const streaming = useChatStore.getState().streaming
    if (!streaming || streaming.requestId !== event.requestId) return

    if (event.type === 'delta') {
      useChatStore.setState({ streaming: { ...streaming, text: streaming.text + event.text } })
      return
    }

    if (event.type === 'done') {
      appendMessage(streaming.chatId, event.message)
      useChatStore.setState({ streaming: null })
      return
    }

    appendMessage(streaming.chatId, {
      id: `error-${event.requestId}`,
      role: 'assistant',
      text: `⚠ ${event.message}`,
      model: '',
      created: new Date().toISOString()
    })
    useChatStore.setState({ streaming: null })
  })
}

function appendMessage(chatId: string, message: ChatMessage): void {
  useChatStore.setState({
    chats: useChatStore
      .getState()
      .chats.map((chat) =>
        chat.id === chatId ? { ...chat, messages: [...chat.messages, message] } : chat
      )
  })
}
