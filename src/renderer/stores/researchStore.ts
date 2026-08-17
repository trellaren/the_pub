import { create } from 'zustand'
import type { ResearchAttachment, Capture } from '@shared/model/research.js'
import type { PdfHighlight } from '@shared/model/research.js'
import { invoke, attempt, on } from '@renderer/lib/ipc.js'

export type CaptureFailureReason = 'offline' | 'not-found' | 'unreadable'

interface ResearchStore {
  attachmentsBySource: Record<string, ResearchAttachment[]>
  highlightsByAttachment: Record<string, PdfHighlight[]>

  loadAttachments: (sourceId: string) => Promise<void>
  addPdf: (sourceId: string, bytes: ArrayBuffer, label: string) => Promise<ResearchAttachment | null>
  addCapture: (sourceId: string, capture: Capture, label: string) => Promise<ResearchAttachment | null>
  /** Fetches `url` in the main process and returns the extracted title/text, ready to hand to `addCapture`. */
  capturePage: (
    url: string
  ) => Promise<{ ok: true; capture: Capture } | { ok: false; reason: CaptureFailureReason } | null>
  readCapture: (sourceId: string, attachmentId: string) => Promise<Capture | null>
  removeAttachment: (sourceId: string, attachmentId: string) => Promise<void>
  readPdf: (sourceId: string, attachmentId: string) => Promise<ArrayBuffer | null>

  loadHighlights: (sourceId: string, attachmentId: string) => Promise<void>
  saveHighlight: (
    sourceId: string,
    attachmentId: string,
    fields: {
      id?: string
      kind?: 'pdf' | 'capture'
      color: string
      categoryId?: string
      note?: string
      quote: string
      page?: number
      rects?: [number, number, number, number][]
      offset?: number
    }
  ) => Promise<PdfHighlight | null>
  removeHighlight: (sourceId: string, attachmentId: string, id: string) => Promise<void>
}

function attachmentKey(sourceId: string, attachmentId: string): string {
  return `${sourceId}/${attachmentId}`
}

function bytesToBase64(bytes: ArrayBuffer): string {
  let binary = ''
  const view = new Uint8Array(bytes)
  for (const byte of view) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToBytes(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

export const useResearchStore = create<ResearchStore>((set, get) => ({
  attachmentsBySource: {},
  highlightsByAttachment: {},

  loadAttachments: async (sourceId) => {
    const attachments = await attempt(
      invoke('research:attachments:list', { sourceId }),
      'Could not load attachments'
    )
    if (!attachments) return
    set({ attachmentsBySource: { ...get().attachmentsBySource, [sourceId]: attachments } })
  },

  addPdf: async (sourceId, bytes, label) => {
    const attachment = await attempt(
      invoke('research:attachments:addPdf', { sourceId, bytesBase64: bytesToBase64(bytes), label }),
      'Could not add PDF attachment'
    )
    if (!attachment) return null
    const current = get().attachmentsBySource[sourceId] ?? []
    set({ attachmentsBySource: { ...get().attachmentsBySource, [sourceId]: [...current, attachment] } })
    return attachment
  },

  addCapture: async (sourceId, capture, label) => {
    const attachment = await attempt(
      invoke('research:attachments:addCapture', { sourceId, capture, label }),
      'Could not add web capture'
    )
    if (!attachment) return null
    const current = get().attachmentsBySource[sourceId] ?? []
    set({ attachmentsBySource: { ...get().attachmentsBySource, [sourceId]: [...current, attachment] } })
    return attachment
  },

  capturePage: async (url) => {
    return attempt(invoke('research:capture', { url }), 'Could not capture that page')
  },

  readCapture: async (sourceId, attachmentId) => {
    return attempt(invoke('research:attachments:readCapture', { sourceId, attachmentId }), 'Could not open capture')
  },

  removeAttachment: async (sourceId, attachmentId) => {
    await attempt(invoke('research:attachments:remove', { sourceId, attachmentId }), 'Could not remove attachment')
    const current = get().attachmentsBySource[sourceId] ?? []
    set({
      attachmentsBySource: {
        ...get().attachmentsBySource,
        [sourceId]: current.filter((attachment) => attachment.id !== attachmentId)
      }
    })
  },

  readPdf: async (sourceId, attachmentId) => {
    const result = await attempt(
      invoke('research:attachments:readPdf', { sourceId, attachmentId }),
      'Could not open PDF'
    )
    return result ? base64ToBytes(result.bytesBase64) : null
  },

  loadHighlights: async (sourceId, attachmentId) => {
    const highlights = await attempt(
      invoke('research:highlights:list', { sourceId, attachmentId }),
      'Could not load highlights'
    )
    if (!highlights) return
    set({
      highlightsByAttachment: {
        ...get().highlightsByAttachment,
        [attachmentKey(sourceId, attachmentId)]: highlights
      }
    })
  },

  saveHighlight: async (sourceId, attachmentId, fields) => {
    const key = attachmentKey(sourceId, attachmentId)
    const existing = fields.id ? get().highlightsByAttachment[key]?.find((h) => h.id === fields.id) : undefined
    const highlight = {
      id: fields.id ?? '',
      sourceId,
      attachmentId,
      kind: fields.kind ?? existing?.kind ?? 'pdf',
      color: fields.color,
      categoryId: fields.categoryId ?? existing?.categoryId ?? '',
      note: fields.note ?? existing?.note ?? '',
      authorId: existing?.authorId ?? '',
      quote: fields.quote,
      page: fields.page ?? existing?.page ?? 0,
      rects: fields.rects ?? existing?.rects ?? [],
      offset: fields.offset ?? existing?.offset ?? -1,
      orphaned: false,
      created: existing?.created ?? new Date().toISOString(),
      modified: new Date().toISOString()
    }
    const saved = await attempt(
      invoke('research:highlights:save', { sourceId, attachmentId, highlight }),
      'Could not save highlight'
    )
    if (!saved) return null
    const current = get().highlightsByAttachment[key] ?? []
    const next = current.some((candidate) => candidate.id === saved.id)
      ? current.map((candidate) => (candidate.id === saved.id ? saved : candidate))
      : [...current, saved]
    set({ highlightsByAttachment: { ...get().highlightsByAttachment, [key]: next } })
    return saved
  },

  removeHighlight: async (sourceId, attachmentId, id) => {
    await attempt(
      invoke('research:highlights:delete', { sourceId, attachmentId, id }),
      'Could not delete highlight'
    )
    const key = attachmentKey(sourceId, attachmentId)
    const current = get().highlightsByAttachment[key] ?? []
    set({
      highlightsByAttachment: { ...get().highlightsByAttachment, [key]: current.filter((h) => h.id !== id) }
    })
  }
}))

on('research:highlights:changed', ({ sourceId, attachmentId }) => {
  void useResearchStore.getState().loadHighlights(sourceId, attachmentId)
})
