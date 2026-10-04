import path from 'node:path'
import fs from 'node:fs/promises'
import { dialog } from 'electron'
import type { IpcRes } from '../../../shared/ipc/contract.js'
import type { ProjectSession } from '../../services/projectSession.js'
import { DOC_EXT, IGNORED_DIRS } from '../../../shared/constants.js'
import type { CslItem } from '../../../shared/model/source.js'
import { parseBibtex } from '../../sources/fromBibtex.js'
import { parseRis } from '../../sources/fromRis.js'
import { lookupSource } from '../../sources/lookup.js'
import { requirePortableName, type HandlerContext } from '../context.js'

/**
 * A document's stable id and title, read from the file itself.
 *
 * The binder identifies chapters by `docId`, and the index cannot supply one for
 * a file it has not reached — which is precisely the file an author has just
 * created and is about to add. Returns null rather than throwing so one
 * unreadable file cannot empty a picker.
 */
async function readIdentity(
  session: ProjectSession,
  target: string
): Promise<{ docId: string; title: string } | null> {
  try {
    const loaded = await session.documents.read(target)
    return { docId: loaded.doc.docId, title: loaded.doc.title }
  } catch {
    return null
  }
}

async function readIdentities(
  session: ProjectSession,
  paths: readonly string[]
): Promise<{ docId: string; path: string; title: string }[]> {
  const identities: { docId: string; path: string; title: string }[] = []
  for (const target of paths) {
    requirePortableName(target)
    const identity = await readIdentity(session, target)
    if (identity) identities.push({ ...identity, path: target })
  }
  return identities
}

/**
 * Read `.bib`/`.ris` files off the local disk and merge what they hold.
 *
 * `fs` directly rather than the project's `VfsAdapter`, deliberately: these
 * are files being imported *from* the machine, chosen in a native file
 * dialog, and have nothing to do with where the project itself lives — the
 * same reason the Word import reads its picked files with `fs`.
 *
 * The format is chosen by extension, falling back to sniffing the contents,
 * because a file saved as `references.txt` from a browser is common and
 * refusing it on the name alone would be unhelpful.
 */
async function importSourceFiles(session: ProjectSession, files: string[]): Promise<NonNullable<IpcRes<'sources:importDialog'>>> {
  const items: CslItem[] = []
  const warnings: string[] = []

  for (const file of files) {
    let text: string
    try {
      text = await fs.readFile(file, 'utf8')
    } catch {
      warnings.push(`Could not read ${path.basename(file)}.`)
      continue
    }

    const extension = path.extname(file).toLowerCase()
    const looksRis = /^\s*TY {2}-/m.test(text)
    const parsed =
      extension === '.ris' || (extension !== '.bib' && extension !== '.bibtex' && looksRis)
        ? parseRis(text)
        : parseBibtex(text)

    if (parsed.items.length === 0 && parsed.warnings.length === 0) {
      warnings.push(`${path.basename(file)} held no references this build could read.`)
    }
    items.push(...parsed.items)
    warnings.push(...parsed.warnings.map((warning) => `${path.basename(file)}: ${warning}`))
  }

  const merged = await session.sources.merge(items)
  return { ...merged, warnings }
}

export function register(ctx: HandlerContext): void {
  const { handle, windows, requireSession, ownerWindow, pickFiles, rescan, noteChanged, highlightChanged } = ctx

  handle('entities:list', (_payload, event) => requireSession(event).entities.snapshot())
  handle('entities:create', async ({ kind, name }, event) => {
    const entity = await requireSession(event).entities.create(kind, name)
    rescan(event)
    return entity
  })
  handle('entities:save', async ({ entity }, event) => {
    const saved = await requireSession(event).entities.save(entity)
    rescan(event)
    return saved
  })
  handle('entities:accept', async ({ id }, event) => {
    const accepted = await requireSession(event).entities.accept(id)
    rescan(event)
    return accepted
  })
  handle('entities:discard', async ({ id }, event) => {
    const session = requireSession(event)
    await session.entities.discard(id)
    rescan(event)
    return { ok: true as const }
  })
  handle('entities:delete', async ({ id }, event) => {
    const session = requireSession(event)
    await session.entities.remove(id)
    rescan(event)
    return { ok: true as const }
  })

  handle('mentions:forEntity', (request, event) =>
    requireSession(event).search.mentionsForEntity(request)
  )
  handle('mentions:summary', (_payload, event) => requireSession(event).search.mentionSummary())
  handle('mentions:confirm', async (ref, event) => {
    const result = await requireSession(event).mentions.confirm(ref)
    const ownerId = windows.ownerWindowId(event.sender)
    if (result.ok && ownerId !== null) windows.sendToSession(ownerId, 'mentions:changed', {})
    return result
  })
  handle('mentions:confirmAll', async ({ entityId }, event) => {
    const result = await requireSession(event).mentions.confirmAll(entityId)
    const ownerId = windows.ownerWindowId(event.sender)
    if (ownerId !== null) windows.sendToSession(ownerId, 'mentions:changed', {})
    return result
  })
  handle('mentions:dismiss', async ({ entityId, docId, surface }, event) => {
    await requireSession(event).mentions.dismiss(entityId, docId, surface)
    const ownerId = windows.ownerWindowId(event.sender)
    if (ownerId !== null) windows.sendToSession(ownerId, 'mentions:changed', {})
    return { ok: true as const }
  })

  handle('notes:list', ({ docId }, event) => requireSession(event).notes.listForDoc(docId))
  handle('notes:create', async ({ docId, anchorId, anchorText, blockIndex }, event) => {
    const note = await requireSession(event).notes.create(docId, anchorId, anchorText, blockIndex)
    noteChanged(event, docId)
    return note
  })
  handle('notes:save', async ({ docId, note }, event) => {
    const saved = await requireSession(event).notes.save(docId, note)
    noteChanged(event, docId)
    return saved
  })
  handle('notes:delete', async ({ docId, noteId }, event) => {
    await requireSession(event).notes.remove(docId, noteId)
    noteChanged(event, docId)
    return { ok: true as const }
  })

  handle('stats:list', (_req, event) => requireSession(event).stats.all())
  handle('stats:exportCsv', async ({ csv }, event) => {
    const picked = await dialog.showSaveDialog(ownerWindow(event), {
      title: 'Export writing stats',
      defaultPath: 'writing-stats.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (picked.canceled || !picked.filePath) return null
    await fs.writeFile(picked.filePath, csv, 'utf8')
    return { ok: true as const, file: picked.filePath }
  })
  handle('stats:record', async ({ date, docId, added, removed, net, minutes }, event) => {
    const ownerId = windows.ownerWindowId(event.sender)
    await requireSession(event).stats.record({ date, docId, added, removed, net, minutes })
    if (ownerId !== null) windows.sendToSession(ownerId, 'stats:changed', {})
    return { ok: true as const }
  })

  handle('highlights:list', ({ docId }, event) => requireSession(event).highlights.listForDoc(docId))
  handle('highlights:collect', async ({ docId, highlightId, color, quote, blockIndex, categoryId }, event) => {
    const collected = await requireSession(event).highlights.collect(docId, highlightId, {
      color,
      quote,
      blockIndex,
      categoryId
    })
    highlightChanged(event, docId)
    return collected
  })
  handle('highlights:save', async ({ docId, highlight }, event) => {
    const saved = await requireSession(event).highlights.save(docId, highlight)
    highlightChanged(event, docId)
    return saved
  })
  handle('highlights:delete', async ({ docId, id }, event) => {
    await requireSession(event).highlights.remove(docId, id)
    highlightChanged(event, docId)
    return { ok: true as const }
  })

  handle('beats:list', (_payload, event) => requireSession(event).beats.snapshot())
  handle('beats:create', ({ title, columnId, docId }, event) =>
    requireSession(event).beats.create({ title, columnId, docId })
  )
  handle('beats:save', ({ beat }, event) => requireSession(event).beats.save(beat))
  handle('beats:delete', async ({ id }, event) => {
    await requireSession(event).beats.remove(id)
    return { ok: true as const }
  })
  handle('beats:saveColumns', ({ columns }, event) =>
    requireSession(event).beats.saveColumns(columns)
  )

  handle('manuscript:view', (_payload, event) => requireSession(event).manuscript.view())
  handle('manuscript:createPart', async ({ title, role }, event) => {
    const session = requireSession(event)
    await session.manuscript.createPart(title, role)
    return session.manuscript.view()
  })
  handle('manuscript:addDocuments', async ({ paths, parentId }, event) => {
    const session = requireSession(event)
    await session.manuscript.addDocuments(await readIdentities(session, paths), parentId)
    return session.manuscript.view()
  })
  handle('manuscript:move', async ({ id, parentId, index }, event) => {
    const session = requireSession(event)
    await session.manuscript.move(id, parentId, index)
    return session.manuscript.view()
  })
  handle('manuscript:rename', async ({ id, title }, event) => {
    const session = requireSession(event)
    await session.manuscript.rename(id, title)
    return session.manuscript.view()
  })
  handle('manuscript:setRole', async ({ id, role }, event) => {
    const session = requireSession(event)
    await session.manuscript.setRole(id, role)
    return session.manuscript.view()
  })
  handle('manuscript:relink', async ({ id, path: target }, event) => {
    const session = requireSession(event)
    const [identity] = await readIdentities(session, [target])
    if (!identity) throw new Error(`${target} is not a readable document`)
    await session.manuscript.relink(id, identity.docId, identity.path, identity.title)
    return session.manuscript.view()
  })
  handle('manuscript:remove', async ({ id }, event) => {
    const session = requireSession(event)
    await session.manuscript.remove(id)
    return session.manuscript.view()
  })
  handle('manuscript:candidates', async (_payload, event) => {
    const session = requireSession(event)
    const inBook = new Set(
      session.manuscript.snapshot().nodes.map((node) => node.docId).filter(Boolean)
    )
    const known = session.search.knownDocuments()
    const files = (await session.adapter.walk('', IGNORED_DIRS)).filter((entry) =>
      entry.path.endsWith(DOC_EXT)
    )
    const candidates: { path: string; title: string; docId: string; inBook: boolean }[] = []
    for (const file of files) {
      // The index covers this in one query for everything already scanned; only
      // a file it has not reached yet costs a read, so opening the picker on a
      // warm project touches no files at all.
      const identity = known.get(file.path) ?? (await readIdentity(session, file.path))
      if (!identity) continue
      candidates.push({ ...identity, path: file.path, inBook: inBook.has(identity.docId) })
    }
    return candidates.sort((a, b) => a.path.localeCompare(b.path))
  })

  handle('maps:list', (_payload, event) => requireSession(event).maps.snapshot())
  handle('maps:create', ({ name, background, width, height }, event) => {
    // The renderer only ever passes back what doc:writeAsset returned, but a
    // path is a path: check it here like every other renderer-supplied one.
    if (background) requirePortableName(background)
    return requireSession(event).maps.create({ name, background, width, height })
  })
  handle('maps:save', ({ map }, event) => {
    if (map.background) requirePortableName(map.background)
    return requireSession(event).maps.save(map)
  })
  handle('maps:delete', async ({ id }, event) => {
    await requireSession(event).maps.remove(id)
    return { ok: true as const }
  })

  handle('sources:list', (_payload, event) => requireSession(event).sources.snapshot())
  handle('sources:create', ({ type }, event) => requireSession(event).sources.create(type))
  handle('sources:save', ({ source }, event) => requireSession(event).sources.save(source))
  handle('sources:delete', async ({ id }, event) => {
    await requireSession(event).sources.remove(id)
    return { ok: true as const }
  })
  handle('sources:accept', ({ id }, event) => requireSession(event).sources.accept(id))
  handle('sources:importDialog', async (_payload, event) => {
    const session = requireSession(event)
    const files = await pickFiles(event, {
      title: 'Import sources',
      filters: [
        { name: 'Bibliography files', extensions: ['bib', 'bibtex', 'ris'] },
        { name: 'BibTeX', extensions: ['bib', 'bibtex'] },
        { name: 'RIS', extensions: ['ris'] }
      ]
    })
    return files && importSourceFiles(session, files)
  })
  handle('sources:lookup', async ({ query }, event) => {
    const session = requireSession(event)
    const result = await lookupSource(query)
    if (!result.ok) return result
    await session.sources.merge([result.item])
    return result
  })
}
