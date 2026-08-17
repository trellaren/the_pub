import { z } from 'zod'
import type { VfsAdapter } from '../vfs/types.js'

const DICTIONARY_FILE = '.thepub/dictionary.json'

const dictionaryFileSchema = z.object({
  words: z.array(z.string())
})

/**
 * The project's custom spellcheck words — character names, invented terms,
 * the ordinary vocabulary a general-purpose dictionary has never heard of.
 *
 * Deliberately not a `JsonCollectionService`: there is no id, no per-item
 * metadata, just a de-duplicated, sorted list of strings. `.thepub/` rather
 * than the app's own data directory, so the words travel with the project —
 * a cast list is part of the manuscript, not a preference of the machine
 * writing it.
 */
export class SpellcheckDictionaryService {
  constructor(private readonly adapter: VfsAdapter) {}

  async load(): Promise<string[]> {
    const raw = await this.adapter.readFile(DICTIONARY_FILE).catch(() => null)
    if (!raw) return []
    try {
      const parsed = dictionaryFileSchema.parse(JSON.parse(raw.toString('utf8')))
      return parsed.words
    } catch {
      // A hand-edited or corrupted file should not block opening the project.
      return []
    }
  }

  async addWord(word: string): Promise<string[]> {
    const trimmed = word.trim()
    if (!trimmed) return this.load()
    const words = await this.load()
    if (words.includes(trimmed)) return words
    const next = [...words, trimmed].sort((a, b) => a.localeCompare(b))
    await this.adapter.writeFile(DICTIONARY_FILE, Buffer.from(JSON.stringify({ words: next }, null, 2) + '\n'))
    return next
  }
}
