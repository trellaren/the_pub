import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { SpellcheckDictionaryService } from './spellcheckDictionaryService.js'
import { LocalAdapter } from '../vfs/localAdapter.js'

let root: string
let adapter: LocalAdapter
let dictionary: SpellcheckDictionaryService

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-dictionary-'))
  adapter = new LocalAdapter(root)
  dictionary = new SpellcheckDictionaryService(adapter)
})

afterEach(async () => {
  await adapter.dispose()
  await fs.rm(root, { recursive: true, force: true })
})

describe('SpellcheckDictionaryService', () => {
  it('starts empty when there is no file on disk', async () => {
    expect(await dictionary.load()).toEqual([])
  })

  it('adds a word and persists it sorted, without duplicates', async () => {
    await dictionary.addWord('Harlan')
    await dictionary.addWord('Aveline')
    await dictionary.addWord('Harlan')

    expect(await dictionary.load()).toEqual(['Aveline', 'Harlan'])

    const raw = await fs.readFile(path.join(root, '.thepub/dictionary.json'), 'utf8')
    expect(JSON.parse(raw)).toEqual({ words: ['Aveline', 'Harlan'] })
  })

  it('ignores a blank word', async () => {
    await dictionary.addWord('   ')
    expect(await dictionary.load()).toEqual([])
  })

  it('tolerates a corrupted dictionary file rather than failing project open', async () => {
    await fs.mkdir(path.join(root, '.thepub'), { recursive: true })
    await fs.writeFile(path.join(root, '.thepub/dictionary.json'), 'not json')
    expect(await dictionary.load()).toEqual([])
  })
})
