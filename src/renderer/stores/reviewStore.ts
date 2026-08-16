import { create } from 'zustand'
import type { AssembledThread } from '@shared/model/review.js'
import type { AuthorProfile } from '@shared/model/author.js'
import type { PresenceBeat } from '@shared/model/presence.js'
import { PRESENCE_BEAT_MS } from '@shared/constants.js'
import { invoke, attempt, on } from '@renderer/lib/ipc.js'

interface ReviewStore {
  threadsByDoc: Record<string, AssembledThread[]>
  authors: AuthorProfile[]
  me: AuthorProfile | null
  presence: PresenceBeat[]
  /** Whether the active editor is proposing changes rather than making them. */
  suggesting: boolean

  loadForDoc: (docId: string) => Promise<void>
  loadMe: () => Promise<void>
  setMe: (changes: { name?: string; color?: string }) => Promise<void>
  createThread: (docId: string, anchorId: string, anchorText: string, blockIndex: number) => Promise<void>
  setStatus: (docId: string, threadId: string, status: 'open' | 'resolved') => Promise<void>
  removeThread: (docId: string, threadId: string) => Promise<void>
  reply: (docId: string, threadId: string, text: string) => Promise<void>
  removeReply: (docId: string, replyId: string) => Promise<void>
  setSuggesting: (suggesting: boolean) => void
  /** Start beating for a document and watch who else is in it. */
  watch: (docId: string) => () => void
}

export const useReviewStore = create<ReviewStore>((set, get) => ({
  threadsByDoc: {},
  authors: [],
  me: null,
  presence: [],
  suggesting: false,

  loadForDoc: async (docId) => {
    const threads = await attempt(invoke('review:list', { docId }), 'Could not load comments')
    if (!threads) return
    const authors = await attempt(invoke('review:authors', {}), 'Could not load authors')
    set({
      threadsByDoc: { ...get().threadsByDoc, [docId]: threads },
      ...(authors ? { authors } : {})
    })
  },

  loadMe: async () => {
    const me = await attempt(invoke('review:me', {}), 'Could not read your author profile')
    if (me) set({ me })
  },

  setMe: async (changes) => {
    const me = await attempt(invoke('review:setMe', changes), 'Could not save your author profile')
    if (me) set({ me })
  },

  createThread: async (docId, anchorId, anchorText, blockIndex) => {
    await attempt(
      invoke('review:createThread', { docId, anchorId, anchorText, blockIndex }),
      'Could not add a comment'
    )
    await get().loadForDoc(docId)
  },

  setStatus: async (docId, threadId, status) => {
    // Optimistic, like `noteStore.patch`: a resolve checkbox that waits for a
    // file write before it moves reads as a broken checkbox, and the write it
    // is waiting for goes to a folder that may be on SFTP.
    set({
      threadsByDoc: {
        ...get().threadsByDoc,
        [docId]: (get().threadsByDoc[docId] ?? []).map((thread) =>
          thread.id === threadId ? { ...thread, status } : thread
        )
      }
    })
    await attempt(invoke('review:setStatus', { docId, threadId, status }), 'Could not update the comment')
    await get().loadForDoc(docId)
  },

  removeThread: async (docId, threadId) => {
    await attempt(invoke('review:deleteThread', { docId, threadId }), 'Could not delete the comment')
    await get().loadForDoc(docId)
  },

  reply: async (docId, threadId, text) => {
    await attempt(invoke('review:reply', { docId, threadId, text }), 'Could not post your reply')
    await get().loadForDoc(docId)
  },

  removeReply: async (docId, replyId) => {
    await attempt(invoke('review:deleteReply', { docId, replyId }), 'Could not delete your reply')
    await get().loadForDoc(docId)
  },

  setSuggesting: (suggesting) => set({ suggesting }),

  watch: (docId) => {
    void invoke('review:enter', { docId }).catch(() => {})
    const poll = async (): Promise<void> => {
      const presence = await invoke('review:presence', { docId }).catch(() => null)
      if (presence) set({ presence })
    }
    void poll()
    // Polled rather than watched: presence files change constantly by design,
    // and a watcher on them would fire a stream of events every heartbeat from
    // every collaborator.
    const timer = setInterval(() => void poll(), PRESENCE_BEAT_MS)
    return () => {
      clearInterval(timer)
      set({ presence: [] })
    }
  }
}))

// A collaborator's file arriving by sync reaches whichever panel is showing the
// discussion — the same route `notes:changed` takes.
on('review:changed', ({ docId }) => {
  void useReviewStore.getState().loadForDoc(docId)
})
