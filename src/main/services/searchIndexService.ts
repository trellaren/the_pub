import { DatabaseSync, type StatementSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import type { VfsAdapter } from '../vfs/types.js'
import type { SearchQuery, SearchHit, IndexProgress } from '../../shared/model/search.js'
import { pubDocumentSchema } from '../../shared/model/document.js'
import { extractBlocks } from '../../shared/pm/extractText.js'
import { DOC_EXT, IGNORED_DIRS } from '../../shared/constants.js'
import { basename } from '../vfs/paths.js'

const SNIPPET_RADIUS = 60

/**
 * Full-text index over the project's documents.
 *
 * Documents are ProseMirror JSON, so the index stores extracted plain text one
 * row per top-level block: that is what makes a hit resolvable to a block the
 * editor can scroll to, and it keeps JSON attribute noise out of the results.
 *
 * The database is a pure cache — deleting it and reopening the project rebuilds
 * it — so it is never the source of truth for anything.
 */
export class SearchIndexService {
  private db: DatabaseSync
  private progress: IndexProgress = { done: 0, total: 0, indexing: false }
  private insertBlock: StatementSync
  private upsertFile: StatementSync
  private deleteBlocks: StatementSync
  private deleteFile: StatementSync

  constructor(
    private readonly adapter: VfsAdapter,
    dbPath: string,
    private readonly onProgress: (progress: IndexProgress) => void
  ) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS files (
        doc_id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        mtime REAL NOT NULL,
        word_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS blocks USING fts5(
        text,
        doc_id UNINDEXED,
        block_index UNINDEXED,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `)
    this.insertBlock = this.db.prepare('INSERT INTO blocks (text, doc_id, block_index) VALUES (?, ?, ?)')
    this.upsertFile = this.db.prepare(
      `INSERT INTO files (doc_id, path, title, mtime, word_count) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(doc_id) DO UPDATE SET path=excluded.path, title=excluded.title,
         mtime=excluded.mtime, word_count=excluded.word_count`
    )
    this.deleteBlocks = this.db.prepare('DELETE FROM blocks WHERE doc_id = ?')
    this.deleteFile = this.db.prepare('DELETE FROM files WHERE doc_id = ?')
  }

  getProgress(): IndexProgress {
    return this.progress
  }

  private setProgress(next: Partial<IndexProgress>): void {
    this.progress = { ...this.progress, ...next }
    this.onProgress(this.progress)
  }

  /** Look up the current path of a document by its stable id. */
  resolvePath(docId: string): string | null {
    const row = this.db.prepare('SELECT path FROM files WHERE doc_id = ?').get(docId) as
      | { path: string }
      | undefined
    return row?.path ?? null
  }

  /** Scan the project and index anything new or changed since the last run. */
  async syncAll(force = false): Promise<void> {
    this.setProgress({ indexing: true, done: 0, total: 0 })
    try {
      if (force) {
        this.db.exec('DELETE FROM blocks; DELETE FROM files;')
      }
      const files = (await this.adapter.walk('', IGNORED_DIRS)).filter((entry) =>
        entry.path.endsWith(DOC_EXT)
      )
      this.setProgress({ total: files.length })

      const known = new Map<string, { docId: string; mtime: number }>()
      for (const row of this.db.prepare('SELECT doc_id, path, mtime FROM files').all() as {
        doc_id: string
        path: string
        mtime: number
      }[]) {
        known.set(row.path, { docId: row.doc_id, mtime: row.mtime })
      }

      const seenPaths = new Set<string>()
      let done = 0
      for (const file of files) {
        seenPaths.add(file.path)
        const existing = known.get(file.path)
        if (!existing || existing.mtime !== (file.mtime ?? 0)) {
          await this.indexDocument(file.path, file.mtime ?? 0)
        }
        done += 1
        if (done % 25 === 0 || done === files.length) this.setProgress({ done })
      }

      // Sweep entries for files that are really gone. This reads the table back
      // *after* indexing rather than trusting the pre-scan snapshot: a document
      // that was moved has just had its row's path rewritten, and removing it by
      // its old path would delete the entry that was only now brought up to date.
      for (const row of this.db.prepare('SELECT doc_id, path FROM files').all() as {
        doc_id: string
        path: string
      }[]) {
        if (!seenPaths.has(row.path)) this.removeDoc(row.doc_id)
      }
    } finally {
      this.setProgress({ indexing: false })
    }
  }

  /** Re-index a single document. Called on every autosave and watcher event. */
  async indexDocument(docPath: string, mtime?: number): Promise<void> {
    let parsed
    try {
      const raw = await this.adapter.readFile(docPath)
      parsed = pubDocumentSchema.parse(JSON.parse(raw.toString('utf8')))
    } catch {
      // Not a readable document (mid-write, or hand-edited into invalid JSON).
      // Leaving the previous index entry is better than dropping the file from
      // search entirely; the next successful save re-indexes it.
      return
    }
    const resolvedMtime = mtime ?? (await this.adapter.stat(docPath))?.mtime ?? Date.now()
    const blocks = extractBlocks(parsed.content).filter((block) => block.text.length > 0)

    this.db.exec('BEGIN')
    try {
      this.deleteBlocks.run(parsed.docId)
      this.upsertFile.run(parsed.docId, docPath, parsed.title, resolvedMtime, parsed.wordCount)
      for (const block of blocks) {
        this.insertBlock.run(block.text, parsed.docId, block.index)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  removeDoc(docId: string): void {
    this.deleteBlocks.run(docId)
    this.deleteFile.run(docId)
  }

  removeByPath(docPath: string): void {
    const row = this.db.prepare('SELECT doc_id FROM files WHERE path = ?').get(docPath) as
      | { doc_id: string }
      | undefined
    if (row) this.removeDoc(row.doc_id)
  }

  query(request: SearchQuery): SearchHit[] {
    const text = request.text.trim()
    if (!text) return []
    const hits = [...this.queryContent(request, text), ...this.queryFilenames(request, text)]
    return hits.sort((a, b) => b.score - a.score).slice(0, request.limit)
  }

  private queryContent(request: SearchQuery, text: string): SearchHit[] {
    const matchExpression = toMatchExpression(text)
    if (!matchExpression) return []
    let rows: { doc_id: string; block_index: number; text: string; rank: number }[]
    try {
      rows = this.db
        .prepare(
          `SELECT b.doc_id, b.block_index, b.text, bm25(blocks) AS rank
           FROM blocks b WHERE blocks MATCH ? ORDER BY rank LIMIT ?`
        )
        .all(matchExpression, request.limit * 2) as typeof rows
    } catch {
      return [] // Malformed FTS expression from an in-progress query.
    }

    const matcher = buildMatcher(text, request)
    const hits: SearchHit[] = []
    for (const row of rows) {
      const file = this.db.prepare('SELECT path, title FROM files WHERE doc_id = ?').get(row.doc_id) as
        | { path: string; title: string }
        | undefined
      if (!file) continue
      if (request.pathPrefix && !file.path.startsWith(request.pathPrefix)) continue

      // FTS matched on tokens; re-check against the literal query so case- and
      // whole-word-sensitive searches return only what the user asked for.
      const ranges = findRanges(row.text, matcher)
      if (ranges.length === 0) continue
      const { snippet, ranges: localRanges } = buildSnippet(row.text, ranges)
      hits.push({
        docId: row.doc_id,
        path: file.path,
        title: file.title,
        blockIndex: row.block_index,
        snippet,
        ranges: localRanges,
        // bm25 returns lower-is-better negatives; flip so higher is better.
        score: -row.rank,
        kind: 'content'
      })
    }
    return hits
  }

  private queryFilenames(request: SearchQuery, text: string): SearchHit[] {
    const needle = text.toLowerCase()
    const rows = this.db.prepare('SELECT doc_id, path, title FROM files').all() as {
      doc_id: string
      path: string
      title: string
    }[]
    const hits: SearchHit[] = []
    for (const row of rows) {
      if (request.pathPrefix && !row.path.startsWith(request.pathPrefix)) continue
      const name = basename(row.path).toLowerCase()
      const index = name.indexOf(needle)
      if (index === -1) continue
      hits.push({
        docId: row.doc_id,
        path: row.path,
        title: row.title,
        blockIndex: 0,
        snippet: row.path,
        ranges: [],
        // Rank filename hits above body text, earlier matches above later ones.
        score: 1000 - index,
        kind: 'filename'
      })
    }
    return hits
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      // Already closed.
    }
  }
}

/**
 * Turn user input into an FTS5 MATCH expression. Every term is quoted so that
 * FTS operators typed by the user (`*`, `OR`, `NEAR`, quotes) are searched for
 * literally instead of changing the query's meaning.
 */
export function toMatchExpression(input: string): string | null {
  const terms = input.match(/[\p{L}\p{N}'’-]+/gu)
  if (!terms || terms.length === 0) return null
  return terms
    .map((term, index) => {
      const quoted = `"${term.replace(/"/g, '""')}"`
      // Prefix-match the final term so results narrow as the user keeps typing.
      return index === terms.length - 1 ? `${quoted}*` : quoted
    })
    .join(' AND ')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildMatcher(text: string, request: Pick<SearchQuery, 'matchCase' | 'wholeWord'>): RegExp {
  const escaped = escapeRegExp(text)
  const pattern = request.wholeWord ? `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])` : escaped
  return new RegExp(pattern, request.matchCase ? 'gu' : 'giu')
}

function findRanges(text: string, matcher: RegExp): { start: number; end: number }[] {
  matcher.lastIndex = 0
  const ranges: { start: number; end: number }[] = []
  let match: RegExpExecArray | null
  while ((match = matcher.exec(text)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length })
    if (match[0].length === 0) matcher.lastIndex += 1
    if (ranges.length >= 50) break
  }
  return ranges
}

/** Trim a block down to a readable window around its first match. */
export function buildSnippet(
  text: string,
  ranges: { start: number; end: number }[]
): { snippet: string; ranges: { start: number; end: number }[] } {
  const first = ranges[0]!
  const start = Math.max(0, first.start - SNIPPET_RADIUS)
  const end = Math.min(text.length, first.end + SNIPPET_RADIUS)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  const snippet = prefix + text.slice(start, end) + suffix
  const offset = prefix.length - start
  const shifted = ranges
    .filter((range) => range.start >= start && range.end <= end)
    .map((range) => ({ start: range.start + offset, end: range.end + offset }))
  return { snippet, ranges: shifted }
}
