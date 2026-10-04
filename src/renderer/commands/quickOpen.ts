export interface DocumentCandidate {
  path: string
  title: string
  docId: string
}

/**
 * Documents whose title or path contains every word of the query, titles
 * first. Path matches count because authors navigate by folder ("act 2 storm")
 * as often as by the chapter's own name.
 */
export function matchDocuments<T extends DocumentCandidate>(documents: T[], query: string, limit = 60): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const scored: Array<{ document: T; score: number }> = []
  for (const document of documents) {
    const title = document.title.toLowerCase()
    const path = document.path.toLowerCase()
    if (!words.every((word) => title.includes(word) || path.includes(word))) continue
    const titleHits = words.filter((word) => title.includes(word)).length
    const prefix = words.length > 0 && title.startsWith(words[0]!) ? 1 : 0
    scored.push({ document, score: titleHits * 2 + prefix })
  }
  return scored
    .sort((a, b) => b.score - a.score || a.document.path.localeCompare(b.document.path))
    .slice(0, limit)
    .map((entry) => entry.document)
}
