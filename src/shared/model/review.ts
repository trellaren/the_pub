import { z } from 'zod'
import { FORMAT_VERSIONS } from '../constants.js'
import { pmDocSchema, EMPTY_DOC } from './document.js'

/**
 * Review comments, and the replies to them.
 *
 * A different record from Phase 2's notes on purpose: a note is the author's
 * own margin thinking, and a review comment is addressed to someone and
 * accumulates replies. They attach the same way — an `anchor` mark — and reuse
 * the same orphan recovery, because that part genuinely is the same problem.
 */
export const reviewThreadSchema = z.object({
  id: z.string(),
  docId: z.string(),
  anchorId: z.string(),
  /** Who wrote it. An id, never a name — see `author.ts`. */
  authorId: z.string(),
  body: pmDocSchema.default(() => structuredClone(EMPTY_DOC)),
  status: z.enum(['open', 'resolved']).default('open'),
  /**
   * Whether `anchorId` was still in the document at the last reconcile. An
   * orphaned thread is never deleted — the mark is gone, not the argument —
   * and stays addressable by `anchorText`.
   */
  orphaned: z.boolean().default(false),
  anchorText: z.string().default(''),
  blockIndex: z.number().int().default(0),
  created: z.string(),
  modified: z.string()
})
export type ReviewThread = z.infer<typeof reviewThreadSchema>

/**
 * A reply, which is its own record rather than a mutation of someone else's.
 *
 * This is what makes concurrent review need no merge code at all. A reply *you*
 * write to *Marta's* thread lives in **your** file carrying her `threadId`, so
 * every file has exactly one writer and the thread is assembled at read time by
 * id. Two reviewers replying at once cannot lose each other's work, because
 * they never write to the same place.
 */
export const reviewReplySchema = z.object({
  id: z.string(),
  threadId: z.string(),
  authorId: z.string(),
  body: pmDocSchema.default(() => structuredClone(EMPTY_DOC)),
  /**
   * A resolution rather than a comment.
   *
   * A thread is resolved by whoever *acted on* it, which is usually the writer
   * rather than the reviewer who raised it — and their status cannot be written
   * into the reviewer's file without giving that file a second writer. So it
   * travels as a record in the resolver's own file, and `assembleThreads` folds
   * the most recent one back in.
   *
   * Its own field rather than a specially-worded reply: a reply whose *text*
   * carries meaning is one a person can type by accident.
   */
  sets: z.enum(['open', 'resolved']).nullable().default(null),
  created: z.string(),
  modified: z.string()
})
export type ReviewReply = z.infer<typeof reviewReplySchema>

/** One (document, author) pair's review work: `.thepub/reviews/<docId>/<authorId>.json`. */
export const reviewFileSchema = z.object({
  formatVersion: z.number().int().default(FORMAT_VERSIONS.reviews),
  threads: z.array(reviewThreadSchema).default(() => []),
  replies: z.array(reviewReplySchema).default(() => [])
})
export type ReviewFile = z.infer<typeof reviewFileSchema>

export const EMPTY_REVIEW_FILE: ReviewFile = {
  formatVersion: FORMAT_VERSIONS.reviews,
  threads: [],
  replies: []
}

/** A thread with everyone's replies gathered onto it, oldest first. */
export const assembledThreadSchema = reviewThreadSchema.extend({
  replies: z.array(reviewReplySchema).default(() => [])
})
export type AssembledThread = z.infer<typeof assembledThreadSchema>

/**
 * Gather every author's file for one document into threads.
 *
 * A reply whose thread is in nobody's file is dropped rather than shown
 * detached: it means the thread was deleted by its author, and a reply to
 * nothing is not a comment anyone can act on.
 */
export function assembleThreads(files: readonly ReviewFile[]): AssembledThread[] {
  const threads = new Map<string, AssembledThread>()
  for (const file of files) {
    for (const thread of file.threads) threads.set(thread.id, { ...thread, replies: [] })
  }
  for (const file of files) {
    for (const reply of file.replies) {
      threads.get(reply.threadId)?.replies.push(reply)
    }
  }
  for (const thread of threads.values()) {
    thread.replies.sort((a, b) => a.created.localeCompare(b.created))
    // The newest resolution wins, whoever made it — including one that reopens
    // a thread its own author had closed.
    const resolution = [...thread.replies].reverse().find((reply) => reply.sets !== null)
    if (resolution?.sets) thread.status = resolution.sets
    // Resolutions are not comments and are not shown as replies.
    thread.replies = thread.replies.filter((reply) => reply.sets === null)
  }
  return [...threads.values()].sort(
    (a, b) => a.blockIndex - b.blockIndex || a.created.localeCompare(b.created)
  )
}
