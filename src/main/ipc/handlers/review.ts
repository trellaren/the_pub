import type { HandlerContext } from '../context.js'

export function register(ctx: HandlerContext): void {
  const { handle, windows, sessions, appState, requireSession, reviewChanged } = ctx

  handle('review:list', async ({ docId }, event) => {
    const session = requireSession(event)
    // Always re-read: a collaborator's file arrives by sync, not by anything
    // this window did, so a cache trusted across calls would show yesterday's
    // discussion.
    session.reviews.invalidate(docId)
    return session.reviews.list(docId)
  })
  handle('review:createThread', async ({ docId, anchorId, anchorText, blockIndex }, event) => {
    const thread = await requireSession(event).reviews.createThread(docId, anchorId, anchorText, blockIndex)
    reviewChanged(event, docId)
    return thread
  })
  handle('review:saveThread', async ({ docId, thread }, event) => {
    await requireSession(event).reviews.patchThread(docId, thread.id, thread)
    reviewChanged(event, docId)
    return { ok: true as const }
  })
  handle('review:setStatus', async ({ docId, threadId, status }, event) => {
    await requireSession(event).reviews.setStatus(docId, threadId, status)
    reviewChanged(event, docId)
    return { ok: true as const }
  })
  handle('review:deleteThread', async ({ docId, threadId }, event) => {
    await requireSession(event).reviews.removeThread(docId, threadId)
    reviewChanged(event, docId)
    return { ok: true as const }
  })
  handle('review:reply', async ({ docId, threadId, text }, event) => {
    const reply = await requireSession(event).reviews.reply(docId, threadId, text)
    reviewChanged(event, docId)
    return reply
  })
  handle('review:saveReply', async ({ docId, reply }, event) => {
    await requireSession(event).reviews.patchReply(docId, reply.id, reply)
    reviewChanged(event, docId)
    return { ok: true as const }
  })
  handle('review:deleteReply', async ({ docId, replyId }, event) => {
    await requireSession(event).reviews.removeReply(docId, replyId)
    reviewChanged(event, docId)
    return { ok: true as const }
  })
  handle('review:authors', async (_payload, event) => {
    const session = requireSession(event)
    session.reviews.invalidateAuthors()
    return session.reviews.listAuthors()
  })
  handle('review:me', () => appState.author())
  handle('review:setMe', async (changes, event) => {
    const profile = appState.setAuthor(changes).author
    const me = appState.author()
    // Record the new name in the project so collaborators see it, if one is
    // open — naming yourself from the welcome screen is perfectly ordinary.
    const ownerId = windows.ownerWindowId(event.sender)
    const session = ownerId === null ? undefined : sessions.get(ownerId)
    await session?.reviews.registerAuthor(me).catch(() => {})
    return { ...me, name: profile.name }
  })
  handle('review:presence', ({ docId }, event) => requireSession(event).presence.list(docId))
  handle('review:enter', ({ docId }, event) => {
    // Fire-and-forget here: the window is told it is present the moment it
    // asks, and the beat lands on its own. Only tests await the first one.
    void requireSession(event).presence.enter(docId)
    return { ok: true as const }
  })
}
