import { create } from 'zustand'
import type {
  Chat,
  ChatMessage,
  AiSettings,
  AiProviderId,
  ToolCall,
  EditProposal
} from '@shared/model/ai.js'
import { modelChoice, type LlmStatus } from '@shared/model/llm.js'
import type { RetrievalStatus } from '@shared/model/retrieval.js'
import { invoke, attempt, on } from '@renderer/lib/ipc.js'

interface ChatStore {
  chats: Chat[]
  settings: AiSettings | null
  activeChatId: string | null
  /** The reply currently arriving, if any. */
  streaming: { requestId: string; chatId: string; text: string; toolCalls: ToolCall[] } | null
  /**
   * Edits the agent has proposed and the author has not yet acted on.
   *
   * Held here rather than applied: the agent has no write path to a document,
   * and this list is the whole of what it can do to prose.
   */
  proposals: EditProposal[]
  dismissProposal: (id: string) => void
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
  /** Embedded models: what is downloaded, what this machine can run, engine state. */
  llm: LlmStatus | null
  /** Bytes so far per variant, for a download in flight. */
  downloads: Record<string, { received: number; total: number }>
  refreshLlm: () => Promise<void>
  downloadModel: (variantId: string) => Promise<string | null>
  cancelDownload: (variantId: string) => Promise<void>
  removeModel: (variantId: string) => Promise<void>
  /**
   * Make a chosen embedded model usable, downloading it if it is not here yet.
   *
   * Returns a message when it cannot be — this machine is too small for it, or
   * the transfer failed — and null when the model is ready to answer.
   */
  ensureModel: (model: string) => Promise<string | null>
  chooseModelFile: () => Promise<string | null>
  /** How much of the manuscript can be searched by meaning. */
  retrieval: RetrievalStatus | null
  refreshRetrieval: () => Promise<void>
  buildRetrieval: () => Promise<void>
  cancelRetrieval: () => Promise<void>
}

export const useChatStore = create<ChatStore>((set, get) => ({
  chats: [],
  settings: null,
  activeChatId: null,
  streaming: null,
  proposals: [],
  dismissProposal: (id) =>
    set({ proposals: get().proposals.filter((proposal) => proposal.id !== id) }),
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
      streaming: { requestId: started.requestId, chatId, text: '', toolCalls: [] }
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
  },

  llm: null,
  downloads: {},

  refreshLlm: async () => {
    const status = await invoke('llm:status', {}).catch(() => null)
    if (status) set({ llm: status })
  },

  downloadModel: async (variantId) => {
    // The download belongs to main and outlives this panel; the promise here is
    // only how the outcome comes back, so closing the panel mid-transfer is
    // safe and reopening it picks the progress back up.
    const result = await invoke('llm:download', { variantId }).catch(() => null)
    await get().refreshLlm()
    if (!result) return 'The download could not be started.'
    return result.ok ? null : result.error || 'The download failed.'
  },

  cancelDownload: async (variantId) => {
    await invoke('llm:cancelDownload', { variantId }).catch(() => {})
    await get().refreshLlm()
  },

  removeModel: async (variantId) => {
    await invoke('llm:remove', { variantId }).catch(() => {})
    await get().refreshLlm()
  },

  ensureModel: async (model) => {
    // Refreshed first, because the decision is made against what is actually on
    // disk and this panel may have been open since before a download finished.
    await get().refreshLlm()
    const choice = modelChoice(model, get().llm?.variants ?? [])
    if (choice.kind === 'ready') return null
    if (choice.kind === 'refuse') return choice.reason
    return get().downloadModel(choice.variantId)
  },

  chooseModelFile: async () => {
    const chosen = await invoke('llm:chooseFile', {}).catch(() => null)
    return chosen?.path ?? null
  },

  retrieval: null,

  refreshRetrieval: async () => {
    const status = await invoke('ai:retrievalStatus', {}).catch(() => null)
    if (status) set({ retrieval: status })
  },

  buildRetrieval: async () => {
    // Like a download, the build belongs to main and outlives this panel: the
    // promise is only how the final state comes back, and progress arrives on
    // its own channel whether anything is watching or not.
    const status = await invoke('ai:buildRetrieval', {}).catch(() => null)
    if (status) set({ retrieval: status })
  },

  cancelRetrieval: async () => {
    await invoke('ai:cancelRetrieval', {}).catch(() => {})
  }
}))

/** Follow the retrieval index filling, which main owns and pushes. */
export function listenForRetrievalProgress(): () => void {
  return on('ai:retrievalProgress', (status) => useChatStore.setState({ retrieval: status }))
}

/** Follow a download's progress, which main owns and pushes. */
export function listenForModelProgress(): () => void {
  return on('llm:progress', (progress) => {
    const downloads = { ...useChatStore.getState().downloads }
    if (progress.done) {
      delete downloads[progress.variantId]
      useChatStore.setState({ downloads })
      void useChatStore.getState().refreshLlm()
      return
    }
    downloads[progress.variantId] = {
      received: progress.receivedBytes,
      total: progress.totalBytes
    }
    useChatStore.setState({ downloads })
  })
}

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

    // A tool call is shown as it happens rather than at the end: an agent that
    // spends twenty seconds searching should say what it is doing while it
    // does it. It is never appended to `text`, which is the reply itself.
    if (event.type === 'tool') {
      useChatStore.setState({
        streaming: { ...streaming, toolCalls: [...streaming.toolCalls, event.call] }
      })
      return
    }

    // Proposals outlive the run that produced them — they sit until accepted or
    // dismissed — so they are kept beside the chat rather than inside the
    // streaming state that is cleared on `done`.
    if (event.type === 'proposal') {
      useChatStore.setState({ proposals: [...useChatStore.getState().proposals, event.proposal] })
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
      toolCalls: [],
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
