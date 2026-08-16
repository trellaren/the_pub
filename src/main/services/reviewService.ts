import { ulid } from 'ulid'
import type { VfsAdapter } from '../vfs/types.js'
import {
  reviewFileSchema,
  reviewThreadSchema,
  reviewReplySchema,
  assembleThreads,
  EMPTY_REVIEW_FILE,
  type ReviewFile,
  type ReviewThread,
  type ReviewReply,
  type AssembledThread
} from '../../shared/model/review.js'
import { authorsFileSchema, EMPTY_AUTHORS_FILE, type AuthorProfile } from '../../shared/model/author.js'
import { migrate } from '../../shared/model/migrate.js'
import { findAnchor } from '../../shared/pm/anchors.js'
import type { PmDoc } from '../../shared/model/document.js'
import { REVIEWS_DIR, AUTHORS_FILE, FORMAT_VERSIONS } from '../../shared/constants.js'

/**
 * Review threads, and who wrote them.
 *
 * The layout is the whole design: `.thepub/reviews/<docId>/<authorId>.json`,
 * so every file has exactly one writer. Concurrent review then needs no merge
 * code on the write path at all — the merging happens at read time, by
 * gathering a directory and assembling threads by id.
 *
 * Writes go through `writeFileAtomic` and only ever to *this* author's file.
 * Nothing here can modify a collaborator's file, which is what makes "a reply
 * is its own record" a structural guarantee rather than a convention.
 */
export class ReviewService {
  /** Per document, by author id. Loaded lazily, like notes. */
  private cache = new Map<string, Map<string, ReviewFile>>()
  private authors: AuthorProfile[] | null = null

  constructor(
    private readonly adapter: VfsAdapter,
    /** Who this app is, for the files it writes. */
    private readonly me: () => AuthorProfile
  ) {}

  private dirFor(docId: string): string {
    return `${REVIEWS_DIR}/${docId}`
  }

  private pathFor(docId: string, authorId: string): string {
    return `${this.dirFor(docId)}/${authorId}.json`
  }

  /** Forget what was read, so a collaborator's synced file is picked up. */
  invalidate(docId?: string): void {
    if (docId) this.cache.delete(docId)
    else this.cache.clear()
  }

  private async loadDoc(docId: string): Promise<Map<string, ReviewFile>> {
    const cached = this.cache.get(docId)
    if (cached) return cached

    const byAuthor = new Map<string, ReviewFile>()
    const entries = await this.adapter.list(this.dirFor(docId)).catch(() => [])
    for (const entry of entries) {
      if (entry.kind !== 'file' || !entry.path.endsWith('.json')) continue
      const authorId = entry.name.replace(/\.json$/, '')
      try {
        const raw = await this.adapter.readFile(entry.path)
        const { value } = migrate('reviews', JSON.parse(raw.toString('utf8')))
        byAuthor.set(authorId, reviewFileSchema.parse(value))
      } catch {
        // One unreadable reviewer's file must not empty the whole discussion.
        // Skipped rather than renamed: it is not ours to move, and the person
        // who wrote it still has it.
      }
    }
    this.cache.set(docId, byAuthor)
    return byAuthor
  }

  private async mine(docId: string): Promise<ReviewFile> {
    const byAuthor = await this.loadDoc(docId)
    const existing = byAuthor.get(this.me().id)
    if (existing) return existing
    const empty: ReviewFile = structuredClone(EMPTY_REVIEW_FILE)
    byAuthor.set(this.me().id, empty)
    return empty
  }

  private async flush(docId: string): Promise<void> {
    const file = (await this.loadDoc(docId)).get(this.me().id)
    if (!file) return
    await this.adapter.mkdir(REVIEWS_DIR).catch(() => {})
    await this.adapter.mkdir(this.dirFor(docId)).catch(() => {})
    await this.adapter.writeFileAtomic(
      this.pathFor(docId, this.me().id),
      Buffer.from(`${JSON.stringify(file, null, 2)}\n`, 'utf8')
    )
  }

  /** Every thread on a document, from every reviewer, with replies gathered. */
  async list(docId: string): Promise<AssembledThread[]> {
    return assembleThreads([...(await this.loadDoc(docId)).values()])
  }

  async createThread(
    docId: string,
    anchorId: string,
    anchorText: string,
    blockIndex: number
  ): Promise<ReviewThread> {
    const file = await this.mine(docId)
    const now = new Date().toISOString()
    const thread: ReviewThread = reviewThreadSchema.parse({
      id: ulid(),
      docId,
      anchorId,
      authorId: this.me().id,
      status: 'open',
      orphaned: false,
      anchorText,
      blockIndex,
      created: now,
      modified: now
    })
    file.threads.push(thread)
    await this.flush(docId)
    return thread
  }

  /**
   * Change a thread. Only your own.
   *
   * Refusing rather than silently no-op'ing: editing someone else's comment is
   * a thing a UI could plausibly offer by mistake, and the refusal is how that
   * gets found.
   */
  async patchThread(docId: string, threadId: string, changes: Partial<ReviewThread>): Promise<void> {
    const file = await this.mine(docId)
    const thread = file.threads.find((candidate) => candidate.id === threadId)
    if (!thread) throw new Error('That comment belongs to another reviewer.')
    Object.assign(thread, changes, {
      id: thread.id,
      authorId: thread.authorId,
      modified: new Date().toISOString()
    })
    await this.flush(docId)
  }

  /**
   * Resolve or reopen a thread — including someone else's.
   *
   * The one exception to "only your own", and it needs one: a thread is
   * resolved by the person who *acted on* it, who is generally the writer
   * rather than the reviewer who raised it. Recorded in the acting author's own
   * file as a resolution record, so no file gains a second writer.
   */
  async setStatus(docId: string, threadId: string, status: 'open' | 'resolved'): Promise<void> {
    const byAuthor = await this.loadDoc(docId)
    const owner = [...byAuthor.entries()].find(([, file]) =>
      file.threads.some((thread) => thread.id === threadId)
    )
    if (!owner) return
    if (owner[0] === this.me().id) {
      await this.patchThread(docId, threadId, { status })
      return
    }
    // Someone else's thread: the decision goes in our own file as a resolution
    // record, which `assembleThreads` folds back in on read. No file ever gains
    // a second writer.
    await this.reply(docId, threadId, '', status)
  }

  async removeThread(docId: string, threadId: string): Promise<void> {
    const file = await this.mine(docId)
    file.threads = file.threads.filter((thread) => thread.id !== threadId)
    file.replies = file.replies.filter((reply) => reply.threadId !== threadId)
    await this.flush(docId)
  }

  /** Add a reply. Always to our own file, whoever's thread it is. */
  async reply(
    docId: string,
    threadId: string,
    text = '',
    sets: 'open' | 'resolved' | null = null
  ): Promise<ReviewReply> {
    const file = await this.mine(docId)
    const now = new Date().toISOString()
    const reply: ReviewReply = reviewReplySchema.parse({
      id: ulid(),
      threadId,
      authorId: this.me().id,
      sets,
      ...(text
        ? { body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } }
        : {}),
      created: now,
      modified: now
    })
    file.replies.push(reply)
    await this.flush(docId)
    return reply
  }

  async patchReply(docId: string, replyId: string, changes: Partial<ReviewReply>): Promise<void> {
    const file = await this.mine(docId)
    const reply = file.replies.find((candidate) => candidate.id === replyId)
    if (!reply) throw new Error('That reply belongs to another reviewer.')
    Object.assign(reply, changes, {
      id: reply.id,
      threadId: reply.threadId,
      authorId: reply.authorId,
      modified: new Date().toISOString()
    })
    await this.flush(docId)
  }

  async removeReply(docId: string, replyId: string): Promise<void> {
    const file = await this.mine(docId)
    file.replies = file.replies.filter((reply) => reply.id !== replyId)
    await this.flush(docId)
  }

  /**
   * Re-check every thread's anchor against the document.
   *
   * The same recovery notes use: a thread whose mark has gone is marked
   * orphaned rather than deleted, and one whose mark has come back — an undo,
   * or a Word round-trip — is un-orphaned. Only our own file is rewritten, so
   * reconciling cannot touch a collaborator's records.
   */
  async reconcile(docId: string, doc: PmDoc): Promise<void> {
    const file = await this.mine(docId)
    let changed = false
    for (const thread of file.threads) {
      const found = findAnchor(doc, thread.anchorId)
      const orphaned = found === null
      if (orphaned !== thread.orphaned) {
        thread.orphaned = orphaned
        changed = true
      }
      if (found && (found.text !== thread.anchorText || found.blockIndex !== thread.blockIndex)) {
        thread.anchorText = found.text
        thread.blockIndex = found.blockIndex
        changed = true
      }
    }
    if (changed) await this.flush(docId)
  }

  /** The project's author registry, read once per session unless invalidated. */
  async listAuthors(): Promise<AuthorProfile[]> {
    if (this.authors) return this.authors
    try {
      const raw = await this.adapter.readFile(AUTHORS_FILE)
      const { value } = migrate('authors', JSON.parse(raw.toString('utf8')))
      this.authors = authorsFileSchema.parse(value).authors
    } catch {
      this.authors = []
    }
    return this.authors
  }

  /**
   * Record who we are in the project, on open.
   *
   * Last-writer-wins per entry, which is fine: the value is display metadata,
   * and the worst case is a stale display name.
   */
  async registerAuthor(profile: AuthorProfile): Promise<void> {
    const authors = await this.listAuthors()
    const existing = authors.find((author) => author.id === profile.id)
    if (existing && existing.name === profile.name && existing.color === profile.color) return

    const next = existing
      ? authors.map((author) => (author.id === profile.id ? profile : author))
      : [...authors, profile]
    this.authors = next
    await this.adapter
      .writeFileAtomic(
        AUTHORS_FILE,
        Buffer.from(
          `${JSON.stringify({ ...EMPTY_AUTHORS_FILE, formatVersion: FORMAT_VERSIONS.authors, authors: next }, null, 2)}\n`,
          'utf8'
        )
      )
      .catch(() => {})
  }

  invalidateAuthors(): void {
    this.authors = null
  }
}
