import type { IpcMainInvokeEvent } from 'electron'
import { capturePage } from '../../research/capture.js'
import type { HandlerContext } from '../context.js'

export function register(ctx: HandlerContext): void {
  const { handle, windows, requireSession } = ctx

  function researchHighlightChanged(event: IpcMainInvokeEvent, sourceId: string, attachmentId: string): void {
    const ownerId = windows.ownerWindowId(event.sender)
    if (ownerId !== null) windows.sendToSession(ownerId, 'research:highlights:changed', { sourceId, attachmentId })
  }

  handle('research:attachments:list', ({ sourceId }, event) =>
    requireSession(event).sources.listAttachments(sourceId)
  )
  handle('research:attachments:addPdf', ({ sourceId, bytesBase64, label }, event) =>
    requireSession(event).sources.addPdfAttachment(sourceId, Buffer.from(bytesBase64, 'base64'), label)
  )
  handle('research:attachments:addCapture', ({ sourceId, capture, label }, event) =>
    requireSession(event).sources.addCaptureAttachment(sourceId, capture, label)
  )
  handle('research:attachments:remove', async ({ sourceId, attachmentId }, event) => {
    await requireSession(event).sources.removeAttachment(sourceId, attachmentId)
    return { ok: true as const }
  })
  handle('research:attachments:readPdf', async ({ sourceId, attachmentId }, event) => {
    const bytes = await requireSession(event).sources.readPdfAttachment(sourceId, attachmentId)
    return { bytesBase64: bytes.toString('base64') }
  })
  handle('research:attachments:readCapture', ({ sourceId, attachmentId }, event) =>
    requireSession(event).sources.readCapture(sourceId, attachmentId)
  )
  handle('research:capture', async ({ url }, event) => {
    requireSession(event) // a project must be open, even though capture itself is project-agnostic
    return capturePage(url, (target) => fetch(target))
  })

  handle('research:highlights:list', ({ sourceId, attachmentId }, event) =>
    requireSession(event).pdfHighlights.listForAttachment(sourceId, attachmentId)
  )
  handle('research:highlights:save', async ({ sourceId, attachmentId, highlight }, event) => {
    const saved = await requireSession(event).pdfHighlights.save(sourceId, attachmentId, highlight)
    researchHighlightChanged(event, sourceId, attachmentId)
    return saved
  })
  handle('research:highlights:delete', async ({ sourceId, attachmentId, id }, event) => {
    await requireSession(event).pdfHighlights.remove(sourceId, attachmentId, id)
    researchHighlightChanged(event, sourceId, attachmentId)
    return { ok: true as const }
  })
}
