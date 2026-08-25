import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { EntityService } from './entityService.js'
import { LocalAdapter } from '../vfs/localAdapter.js'
import { ENTITIES_FILE, FORMAT_VERSIONS } from '../../shared/constants.js'

let root: string
let adapter: LocalAdapter
let entities: EntityService

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-entities-'))
  adapter = new LocalAdapter(root)
  entities = new EntityService(adapter)
  await entities.load()
})

afterEach(async () => {
  await adapter.dispose()
  await fs.rm(root, { recursive: true, force: true })
})

async function readFile(): Promise<string> {
  return fs.readFile(path.join(root, ENTITIES_FILE), 'utf8')
}

describe('EntityService', () => {
  it('starts empty when there is no file', async () => {
    expect(entities.snapshot().entities).toEqual([])
    expect(entities.snapshot().dismissed).toEqual([])
  })

  it('creates a record with an id, a colour and timestamps', async () => {
    const harlan = await entities.create('character', 'Harlan')
    expect(harlan.id).toBeTruthy()
    expect(harlan.color).toBeTruthy()
    expect(harlan.created).toBe(harlan.modified)
    expect(entities.get(harlan.id)?.name).toBe('Harlan')
  })

  it('writes through to disk and reloads', async () => {
    await entities.create('character', 'Harlan')
    await entities.create('location', 'Blue Ridge')

    const reloaded = new EntityService(adapter)
    const file = await reloaded.load()
    expect(file.entities.map((entity) => entity.name)).toEqual(['Harlan', 'Blue Ridge'])
    expect(file.entities.map((entity) => entity.kind)).toEqual(['character', 'location'])
  })

  it('round-trips every field of a record', async () => {
    const created = await entities.create('character', 'Harlan')
    await entities.save({
      ...created,
      name: 'Harlan Reed',
      aliases: [{ text: 'the Sheriff', scan: false }],
      summary: 'Keeps the peace, barely.',
      fields: [{ label: 'Age', value: '52' }],
      relations: [{ targetId: 'other', label: 'brother of' }],
      scan: false,
      notes: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A note' }] }] }
    })

    const reloaded = new EntityService(adapter)
    const [entity] = (await reloaded.load()).entities
    expect(entity).toMatchObject({
      name: 'Harlan Reed',
      summary: 'Keeps the peace, barely.',
      scan: false,
      aliases: [{ text: 'the Sheriff', scan: false }],
      fields: [{ label: 'Age', value: '52' }],
      relations: [{ targetId: 'other', label: 'brother of' }]
    })
    expect(entity!.notes.content?.[0]?.content?.[0]?.text).toBe('A note')
  })

  it('keeps the original created stamp and moves modified', async () => {
    const created = await entities.create('character', 'Harlan')
    const saved = await entities.save({ ...created, created: '1999-01-01T00:00:00.000Z', name: 'Nope' })
    expect(saved.created).toBe(created.created)
    expect(Date.parse(saved.modified)).toBeGreaterThanOrEqual(Date.parse(created.modified))
  })

  it('hands out copies, so a caller cannot mutate the cache', async () => {
    const harlan = await entities.create('character', 'Harlan')
    const snapshot = entities.snapshot()
    snapshot.entities[0]!.name = 'Tampered'
    snapshot.entities.push(harlan)
    expect(entities.get(harlan.id)?.name).toBe('Harlan')
    expect(entities.snapshot().entities).toHaveLength(1)
  })

  it('deletes a record and its dismissals', async () => {
    const harlan = await entities.create('character', 'Harlan')
    await entities.dismiss(harlan.id, 'doc1', 'Harlan')
    await entities.remove(harlan.id)
    expect(entities.snapshot().entities).toEqual([])
    // Otherwise a future record reusing the id would start silently muted.
    expect(entities.snapshot().dismissed).toEqual([])
  })

  it('does not record the same dismissal twice', async () => {
    await entities.dismiss('e1', 'doc1', 'Harlan')
    await entities.dismiss('e1', 'doc1', 'Harlan')
    expect(entities.snapshot().dismissed).toHaveLength(1)
  })

  it('falls back to an empty roster on a corrupt file, keeping the original', async () => {
    await entities.create('character', 'Harlan')
    await fs.writeFile(path.join(root, ENTITIES_FILE), '{ this is not json', 'utf8')

    const reloaded = new EntityService(adapter)
    const file = await reloaded.load()
    expect(file.entities).toEqual([])

    // The unreadable file holds work nobody can retype, so it is set aside.
    const kept = (await fs.readdir(path.join(root, '.thepub'))).filter((name) =>
      name.includes('.corrupt-')
    )
    expect(kept).toHaveLength(1)
  })

  it('survives a file that parses but has the wrong shape', async () => {
    await fs.mkdir(path.join(root, '.thepub'), { recursive: true })
    await fs.writeFile(path.join(root, ENTITIES_FILE), JSON.stringify({ entities: 'nope' }), 'utf8')
    const reloaded = new EntityService(adapter)
    expect((await reloaded.load()).entities).toEqual([])
  })

  it('applies concurrent saves in order', async () => {
    const harlan = await entities.create('character', 'Harlan')
    await Promise.all([
      entities.save({ ...harlan, name: 'One' }),
      entities.save({ ...harlan, name: 'Two' }),
      entities.save({ ...harlan, name: 'Three' })
    ])
    const written = JSON.parse(await readFile()) as { entities: { name: string }[] }
    expect(written.entities[0]!.name).toBe('Three')
    expect(entities.get(harlan.id)?.name).toBe('Three')
  })

  it('drafts a record that is real, flagged, and survives a reload', async () => {
    const drafted = await entities.draft('character', 'Aurelio', { summary: 'A dockworker.' })
    expect(drafted.provisional).toBe(true)

    const reloaded = new EntityService(adapter)
    const file = await reloaded.load()
    // A draft in a sidecar file is a preview; a provisional record is a draft.
    // It has to still be one after the project closes and reopens.
    expect(file.entities[0]!.provisional).toBe(true)
    expect(file.formatVersion).toBe(FORMAT_VERSIONS.entities)
  })

  it('clears the flag on accept, and changes nothing else', async () => {
    const drafted = await entities.draft('character', 'Aurelio', { summary: 'A dockworker.' })
    const accepted = await entities.accept(drafted.id)

    expect(accepted.provisional).toBe(false)
    expect(accepted.id).toBe(drafted.id)
    expect(accepted.name).toBe('Aurelio')
    expect(accepted.summary).toBe('A dockworker.')
  })

  it('refuses to revise a record the writer has accepted', async () => {
    /*
     * The invariant the whole phase rests on: a tool may only change a record
     * nobody has accepted. Enforced by the service refusing, not by asking the
     * model nicely — the failure it prevents is a character the writer spent an
     * afternoon on being quietly rewritten.
     */
    const drafted = await entities.draft('character', 'Aurelio', { summary: 'A dockworker.' })
    await entities.revise(drafted.id, { summary: 'A dockworker with a debt.' })
    expect(entities.get(drafted.id)?.summary).toBe('A dockworker with a debt.')

    await entities.accept(drafted.id)
    await expect(entities.revise(drafted.id, { summary: 'Something else' })).rejects.toThrow(/accepted/)
    expect(entities.get(drafted.id)?.summary).toBe('A dockworker with a debt.')
  })

  it('will not let a revision accept the record it is revising', async () => {
    // Accepting is a person's act. A revision that could clear the flag would
    // be an accept wearing a different name.
    const drafted = await entities.draft('character', 'Aurelio')
    const revised = await entities.revise(drafted.id, { provisional: false, summary: 'x' })
    expect(revised.provisional).toBe(true)
  })

  it('discards a draft but refuses to discard accepted work', async () => {
    const kept = await entities.draft('character', 'Aurelio')
    const thrown = await entities.draft('character', 'Benedita')
    await entities.accept(kept.id)

    await expect(entities.discard(kept.id)).rejects.toThrow(/deliberately/)
    await entities.discard(thrown.id)
    expect(entities.snapshot().entities.map((entity) => entity.name)).toEqual(['Aurelio'])
  })

  it('creates an ordinary record that is nobody\'s draft', async () => {
    const harlan = await entities.create('character', 'Harlan')
    expect(harlan.provisional).toBe(false)
  })
})
