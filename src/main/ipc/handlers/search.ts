import type { HandlerContext } from '../context.js'

export function register({ handle, requireSession }: HandlerContext): void {
  handle('search:query', (query, event) => requireSession(event).search.query(query))
  handle('search:status', (_payload, event) => requireSession(event).search.getProgress())
  handle('search:reindex', async (_payload, event) => {
    void requireSession(event).search.syncAll(true).catch(() => {})
    return { ok: true as const }
  })

  handle('spellcheck:setLanguage', ({ lang }, event) => {
    // An invalid or unsupported BCP-47 tag must not crash the whole app —
    // Electron throws for one Chromium's spellchecker doesn't recognise, and
    // the fallback is simply "keep whatever was set before".
    try {
      event.sender.session.setSpellCheckerLanguages([lang])
    } catch {
      // Deliberately ignored — see above.
    }
    return { ok: true as const }
  })
  handle('spellcheck:listWords', async (_payload, event) => requireSession(event).dictionary.load())
  handle('spellcheck:addWord', async ({ word }, event) => {
    const session = requireSession(event)
    const words = await session.dictionary.addWord(word)
    event.sender.session.addWordToSpellCheckerDictionary(word)
    return words
  })
}
