import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { ReviewService } from './reviewService.js'
import { PresenceService } from './presenceService.js'
import { LocalAdapter } from '../vfs/localAdapter.js'
import { ANCHOR_MARK } from '../../shared/model/anchor.js'
import type { AuthorProfile } from '../../shared/model/author.js'
import type { PmDoc } from '../../shared/model/document.js'
import { REVIEWS_DIR } from '../../shared/constants.js'

const MARTA: AuthorProfile = { id: 'marta', name: 'Marta', color: '#c2410c' }
const SAM: AuthorProfile = { id: 'sam', name: 'Sam', color: '#0369a1' }

let root: string
let adapter: LocalAdapter
/** Two people on one project folder — the arrangement the whole layout is for. */
let hers: ReviewService
let his: ReviewService

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-review-'))
  adapter = new LocalAdapter(root)
  hers = new ReviewService(adapter, () => MARTA)
  his = new ReviewService(adapter, () => SAM)
})

afterEach(async () => {
  await adapter.dispose()
  await fs.rm(root, { recursive: true, force: true })
})

function docWithAnchor(text: string, anchorId: string): PmDoc {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text, marks: [{ type: ANCHOR_MARK, attrs: { anchorId } }] }]
      }
    ]
  }
}

describe('ReviewService', () => {
  it('starts empty for a document nobody has reviewed', async () => {
    expect(await hers.list('doc-1')).toEqual([])
  })

  it('writes one file per author, never a shared one', async () => {
    await hers.createThread('doc-1', 'a1', 'The harbour', 0)
    await his.createThread('doc-1', 'a2', 'was quiet', 0)
    const files = await fs.readdir(path.join(root, REVIEWS_DIR, 'doc-1'))
    expect(files.sort()).toEqual(['marta.json', 'sam.json'])
  })

  it('gathers both reviewers into one list', async () => {
    await hers.createThread('doc-1', 'a1', 'The harbour', 0)
    await his.createThread('doc-1', 'a2', 'was quiet', 1)
    his.invalidate()
    expect((await his.list('doc-1')).map((thread) => thread.authorId)).toEqual(['marta', 'sam'])
  })

  it('puts a reply to someone else’s thread in the replier’s own file', async () => {
    const thread = await hers.createThread('doc-1', 'a1', 'The harbour', 0)
    his.invalidate()
    await his.reply('doc-1', thread.id, 'Agreed.')

    // The point of the layout: Marta's file is untouched by Sam's reply, so two
    // reviewers working at once cannot lose each other's work.
    const mine = JSON.parse(
      await fs.readFile(path.join(root, REVIEWS_DIR, 'doc-1', 'marta.json'), 'utf8')
    )
    expect(mine.replies).toEqual([])

    hers.invalidate()
    const gathered = await hers.list('doc-1')
    expect(gathered[0]!.replies.map((reply) => reply.authorId)).toEqual(['sam'])
  })

  it('refuses to edit a thread that is not ours', async () => {
    const thread = await hers.createThread('doc-1', 'a1', 'The harbour', 0)
    his.invalidate()
    await expect(his.patchThread('doc-1', thread.id, { anchorText: 'x' })).rejects.toThrow(
      /another reviewer/
    )
  })

  it('lets the writer resolve the reviewer’s thread without writing to their file', async () => {
    const thread = await hers.createThread('doc-1', 'a1', 'The harbour', 0)
    his.invalidate()
    await his.setStatus('doc-1', thread.id, 'resolved')

    const mine = JSON.parse(
      await fs.readFile(path.join(root, REVIEWS_DIR, 'doc-1', 'marta.json'), 'utf8')
    )
    expect(mine.threads[0].status).toBe('open')

    hers.invalidate()
    expect((await hers.list('doc-1'))[0]!.status).toBe('resolved')
  })

  it('shows a resolution as a status, not as an empty reply', async () => {
    const thread = await hers.createThread('doc-1', 'a1', 'The harbour', 0)
    his.invalidate()
    await his.setStatus('doc-1', thread.id, 'resolved')
    hers.invalidate()
    expect((await hers.list('doc-1'))[0]!.replies).toEqual([])
  })

  it('reopens on the newest decision, whoever made it', async () => {
    const thread = await hers.createThread('doc-1', 'a1', 'The harbour', 0)
    his.invalidate()
    await his.setStatus('doc-1', thread.id, 'resolved')
    await his.setStatus('doc-1', thread.id, 'open')
    hers.invalidate()
    expect((await hers.list('doc-1'))[0]!.status).toBe('open')
  })

  it('orphans a thread whose anchor has gone, and un-orphans it when it returns', async () => {
    const thread = await hers.createThread('doc-1', 'a1', 'The harbour', 0)
    await hers.reconcile('doc-1', { type: 'doc', content: [{ type: 'paragraph' }] })
    expect((await hers.list('doc-1'))[0]!.orphaned).toBe(true)

    await hers.reconcile('doc-1', docWithAnchor('The harbour', 'a1'))
    const back = (await hers.list('doc-1'))[0]!
    expect(back.orphaned).toBe(false)
    expect(back.id).toBe(thread.id)
  })

  it('survives one reviewer’s file being unreadable', async () => {
    await hers.createThread('doc-1', 'a1', 'The harbour', 0)
    await fs.writeFile(path.join(root, REVIEWS_DIR, 'doc-1', 'broken.json'), '{ not json')
    hers.invalidate()
    expect(await hers.list('doc-1')).toHaveLength(1)
  })

  it('registers an author once and updates a changed name in place', async () => {
    await hers.registerAuthor(MARTA)
    await hers.registerAuthor({ ...MARTA, name: 'Marta V.' })
    expect(await hers.listAuthors()).toEqual([{ ...MARTA, name: 'Marta V.' }])
  })
})

describe('PresenceService', () => {
  it('reports a collaborator but never yourself', async () => {
    const mine = new PresenceService(adapter, () => MARTA)
    const theirs = new PresenceService(adapter, () => SAM)
    theirs.enter('doc-1')
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect((await mine.list('doc-1')).map((beat) => beat.authorId)).toEqual(['sam'])
    expect(await theirs.list('doc-1')).toEqual([])
    theirs.stop()
  })

  it('does not report someone reading a different document', async () => {
    const theirs = new PresenceService(adapter, () => SAM)
    theirs.enter('doc-2')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await new PresenceService(adapter, () => MARTA).list('doc-1')).toEqual([])
    theirs.stop()
  })

  it('clears the beat on leaving rather than waiting out the TTL', async () => {
    const theirs = new PresenceService(adapter, () => SAM)
    theirs.enter('doc-1')
    await new Promise((resolve) => setTimeout(resolve, 20))
    await theirs.leave()
    expect(await new PresenceService(adapter, () => MARTA).list('doc-1')).toEqual([])
  })
})
