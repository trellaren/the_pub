import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { VfsAdapter } from '../vfs/types.js'
import type { SearchQuery, SearchHit, IndexProgress } from '../../shared/model/search.js'
import type { MentionHit, MentionQuery, MentionCounts } from '../../shared/model/mention.js'
import type { EntityFile } from '../../shared/model/entity.js'
import { pubDocumentSchema } from '../../shared/model/document.js'
import {
  buildScanForms,
  scanBlockText,
  dismissKey,
  extractDocumentMentions,
  type ScanForm
} from '../../shared/pm/mentions.js'
import { DOC_EXT, IGNORED_DIRS, MAX_SUGGESTIONS_PER_DOC } from '../../shared/constants.js'
import { basename } from '../vfs/paths.js'
import { dot, fromBlob, toBlob } from '../ai/vectors.js'

const SNIPPET_RADIUS = 60

/**
 * A passage found by meaning rather than by words.
 *
 * Not a `SearchHit`: there are no matched ranges to highlight, and the score is
 * a cosine rather than a bm25 rank, so pouring it into the same shape would put
 * two incomparable numbers in one field. Nothing but the agent's retrieval tool
 * consumes these, so they stay in main rather than becoming a shared model.
 */
export interface SemanticHit {
  docId: string
  path: string
  title: string
  blockIndex: number
  text: string
  /** Cosine similarity, 0 to 1. */
  score: number
}

/** Identifies a block's text, so an unchanged paragraph keeps its vector. */
function textHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16)
}

/**
 * Bumped whenever the schema below changes.
 *
 * The guard that reads it is not optional. `syncAll` diffs mtimes, so adding a
 * table without dropping `files` would leave the new table permanently empty on
 * every existing project — a silent failure with no error to notice. Dropping
 * `files` is what forces the mtime diff to re-index everything. The database is
 * a pure cache, so a rebuild is the cheapest correct migration.
 */
const SCHEMA_VERSION = 3

/** How the indexer reaches the current roster; see the constructor. */
export type RosterSource = () => EntityFile

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
  private insertMention: StatementSync
  private deleteMentions: StatementSync
  private insertEmbedding: StatementSync
  private deleteEmbeddings: StatementSync
  private pruneEmbedding: StatementSync
  /** Compiled forms and dismissals, rebuilt on demand; see `invalidateRoster`. */
  private compiled: { forms: ScanForm[]; dismissed: Map<string, Set<string>> } | null = null

  /**
   * @param getRoster reaches the records for name scanning. A callback rather
   * than a setter or a service reference: a setter leaves a window in which
   * indexing runs against an empty roster, and holding an `EntityService` here
   * would invert the dependency between the two.
   */
  constructor(
    private readonly adapter: VfsAdapter,
    dbPath: string,
    private readonly onProgress: (progress: IndexProgress) => void,
    private readonly getRoster: RosterSource
  ) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.migrate()
    this.db.exec(`
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
      CREATE TABLE IF NOT EXISTS mentions (
        doc_id        TEXT    NOT NULL,
        block_index   INTEGER NOT NULL,
        start_offset  INTEGER NOT NULL,
        end_offset    INTEGER NOT NULL,
        entity_id     TEXT    NOT NULL,
        ordinal       INTEGER NOT NULL,
        surface       TEXT    NOT NULL,
        confirmed     INTEGER NOT NULL,
        snippet       TEXT    NOT NULL,
        snippet_start INTEGER NOT NULL,
        snippet_end   INTEGER NOT NULL,
        PRIMARY KEY (doc_id, block_index, start_offset, entity_id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS mentions_by_entity
        ON mentions (entity_id, confirmed, doc_id, block_index);
      CREATE TABLE IF NOT EXISTS embeddings (
        doc_id      TEXT    NOT NULL,
        block_index INTEGER NOT NULL,
        text_hash   TEXT    NOT NULL,
        vector      BLOB    NOT NULL,
        PRIMARY KEY (doc_id, block_index)
      ) WITHOUT ROWID;
    `)
    this.insertBlock = this.db.prepare('INSERT INTO blocks (text, doc_id, block_index) VALUES (?, ?, ?)')
    this.upsertFile = this.db.prepare(
      `INSERT INTO files (doc_id, path, title, mtime, word_count) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(doc_id) DO UPDATE SET path=excluded.path, title=excluded.title,
         mtime=excluded.mtime, word_count=excluded.word_count`
    )
    this.deleteBlocks = this.db.prepare('DELETE FROM blocks WHERE doc_id = ?')
    this.deleteFile = this.db.prepare('DELETE FROM files WHERE doc_id = ?')
    // The snippet is stored rather than joined from `blocks` at read time:
    // `blocks` is an FTS5 table whose doc_id is UNINDEXED, so any lookup by it
    // is a full scan. It cannot go stale — a document's mentions and its blocks
    // are always rebuilt in the same transaction.
    this.insertMention = this.db.prepare(
      `INSERT OR REPLACE INTO mentions
         (doc_id, block_index, start_offset, end_offset, entity_id, ordinal, surface,
          confirmed, snippet, snippet_start, snippet_end)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    this.deleteMentions = this.db.prepare('DELETE FROM mentions WHERE doc_id = ?')
    this.insertEmbedding = this.db.prepare(
      `INSERT INTO embeddings (doc_id, block_index, text_hash, vector) VALUES (?, ?, ?, ?)
       ON CONFLICT(doc_id, block_index) DO UPDATE SET
         text_hash = excluded.text_hash, vector = excluded.vector`
    )
    this.deleteEmbeddings = this.db.prepare('DELETE FROM embeddings WHERE doc_id = ?')
    // Keyed on the text rather than on the block, so re-saving a chapter costs
    // embeddings only for the paragraphs that actually changed. Without this a
    // one-word fix would re-embed the whole book.
    this.pruneEmbedding = this.db.prepare(
      'DELETE FROM embeddings WHERE doc_id = ? AND block_index = ? AND text_hash <> ?'
    )
  }

  /** Drop everything derived when the schema moves on. See `SCHEMA_VERSION`. */
  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined
    if (Number(row?.user_version ?? 0) === SCHEMA_VERSION) return
    this.db.exec(`
      DROP TABLE IF EXISTS embeddings;
      DROP TABLE IF EXISTS mentions;
      DROP TABLE IF EXISTS blocks;
      DROP TABLE IF EXISTS files;
    `)
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  }

  /**
   * Forget the compiled roster. Call after any change to records — a rename, a
   * new alias, a scan flag — before rescanning.
   */
  invalidateRoster(): void {
    this.compiled = null
  }

  private roster(): { forms: ScanForm[]; dismissed: Map<string, Set<string>> } {
    if (!this.compiled) {
      const file = this.getRoster()
      const dismissed = new Map<string, Set<string>>()
      for (const item of file.dismissed) {
        const set = dismissed.get(item.docId) ?? new Set<string>()
        set.add(dismissKey(item.entityId, item.surface))
        dismissed.set(item.docId, set)
      }
      this.compiled = { forms: buildScanForms(file.entities), dismissed }
    }
    return this.compiled
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

  /**
   * Every indexed document, keyed by its current path.
   *
   * For pickers that need a document's identity and name without opening it.
   * The caller must still handle a path the index has never seen — during the
   * first pass, or for a file created moments ago — so this is an accelerator
   * rather than the roster itself.
   */
  knownDocuments(): Map<string, { docId: string; title: string }> {
    const rows = this.db.prepare('SELECT doc_id, path, title FROM files').all() as {
      doc_id: string
      path: string
      title: string
    }[]
    return new Map(rows.map((row) => [row.path, { docId: row.doc_id, title: row.title }]))
  }

  /**
   * Word counts for a set of documents, by stable id.
   *
   * One query for a whole manuscript rather than a read per chapter. The column
   * is already maintained on every save and every watcher event, so a book's
   * total costs a single statement and no file access at all — which is what
   * makes it affordable on a project served over SFTP, where reading forty
   * chapters to add up their words would be unthinkable.
   *
   * Ids absent from the index are simply absent from the result. A caller
   * treating that as zero understates the total, which is the right direction:
   * a fabricated count would make a document look modified to anything
   * comparing counts.
   */
  wordCountsFor(docIds: readonly string[]): Map<string, number> {
    const counts = new Map<string, number>()
    if (docIds.length === 0) return counts
    const placeholders = docIds.map(() => '?').join(',')
    const rows = this.db
      .prepare(`SELECT doc_id, word_count FROM files WHERE doc_id IN (${placeholders})`)
      .all(...docIds) as { doc_id: string; word_count: number }[]
    for (const row of rows) counts.set(row.doc_id, row.word_count)
    return counts
  }

  /** Scan the project and index anything new or changed since the last run. */
  async syncAll(force = false): Promise<void> {
    this.setProgress({ indexing: true, done: 0, total: 0 })
    try {
      if (force) {
        this.db.exec('DELETE FROM embeddings; DELETE FROM mentions; DELETE FROM blocks; DELETE FROM files;')
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
    const { forms, dismissed } = this.roster()
    const extracted = extractDocumentMentions(parsed.content, {
      forms,
      dismissed: dismissed.get(parsed.docId)
    })
    const blocks = extracted.blocks.filter((block) => block.text.length > 0)
    const blockText = new Map(extracted.blocks.map((block) => [block.index, block.text]))

    // One transaction for both tables. Delete-then-reinsert is what keeps double
    // indexing idempotent — the doc:write handler and the watcher both index
    // every save today.
    this.db.exec('BEGIN')
    try {
      this.deleteBlocks.run(parsed.docId)
      this.deleteMentions.run(parsed.docId)
      this.upsertFile.run(parsed.docId, docPath, parsed.title, resolvedMtime, parsed.wordCount)
      for (const block of blocks) {
        this.insertBlock.run(block.text, parsed.docId, block.index)
      }
      for (const mention of extracted.mentions) {
        this.writeMention(parsed.docId, mention, blockText.get(mention.blockIndex) ?? '')
      }
      this.pruneEmbeddingsFor(parsed.docId, blocks)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private writeMention(
    docId: string,
    mention: { blockIndex: number; start: number; end: number; entityId: string; ordinal: number; surface: string; confirmed: boolean },
    text: string
  ): void {
    const { snippet, ranges } = buildSnippet(text, [{ start: mention.start, end: mention.end }])
    const range = ranges[0] ?? { start: 0, end: 0 }
    this.insertMention.run(
      docId,
      mention.blockIndex,
      mention.start,
      mention.end,
      mention.entityId,
      mention.ordinal,
      mention.surface,
      mention.confirmed ? 1 : 0,
      snippet,
      range.start,
      range.end
    )
  }

  /**
   * Drop the vectors this document's edit invalidated.
   *
   * A block whose text is unchanged keeps its vector even though the row it
   * came from was just deleted and reinserted — that is the whole of what makes
   * embedding incremental. Blocks past the new end go too: a chapter that lost
   * its last three paragraphs would otherwise keep answering searches with
   * prose that is no longer in it.
   */
  private pruneEmbeddingsFor(docId: string, blocks: readonly { index: number; text: string }[]): void {
    const kept = new Set<number>()
    for (const block of blocks) {
      kept.add(block.index)
      this.pruneEmbedding.run(docId, block.index, textHash(block.text))
    }
    for (const row of this.db
      .prepare('SELECT block_index FROM embeddings WHERE doc_id = ?')
      .all(docId) as { block_index: number }[]) {
      if (!kept.has(row.block_index)) {
        this.db.prepare('DELETE FROM embeddings WHERE doc_id = ? AND block_index = ?').run(docId, row.block_index)
      }
    }
  }

  /** Blocks with no current vector, oldest document first. */
  pendingEmbeddings(limit: number): { docId: string; blockIndex: number; text: string }[] {
    const rows = this.db
      .prepare(
        `SELECT b.doc_id, b.block_index, b.text FROM blocks b
         LEFT JOIN embeddings e ON e.doc_id = b.doc_id AND e.block_index = b.block_index
         WHERE e.doc_id IS NULL LIMIT ?`
      )
      .all(limit) as { doc_id: string; block_index: number; text: string }[]
    return rows.map((row) => ({ docId: row.doc_id, blockIndex: row.block_index, text: row.text }))
  }

  writeEmbedding(docId: string, blockIndex: number, text: string, vector: Float32Array): void {
    this.insertEmbedding.run(docId, blockIndex, textHash(text), toBlob(vector))
  }

  /** How much of the manuscript can be searched by meaning, and how much cannot. */
  embeddingCoverage(): { embedded: number; total: number } {
    const embedded = this.db.prepare('SELECT COUNT(*) AS count FROM embeddings').get() as { count: number }
    const total = this.db.prepare('SELECT COUNT(*) AS count FROM blocks').get() as { count: number }
    return { embedded: Number(embedded.count), total: Number(total.count) }
  }

  clearEmbeddings(): void {
    this.db.exec('DELETE FROM embeddings')
  }

  /**
   * The passages closest in meaning to a query vector.
   *
   * A brute-force scan, on purpose — see `vectors.ts`. Both vectors are already
   * unit length, so the cosine is the dot product and the whole search is one
   * multiply-add per dimension per block.
   *
   * The block texts are read in one pass afterwards rather than joined per hit:
   * `blocks` is an FTS5 table whose `doc_id` is UNINDEXED, so a lookup by it is
   * a full scan either way, and doing it once beats doing it per result.
   */
  nearestBlocks(query: Float32Array, limit: number): SemanticHit[] {
    const scored: { docId: string; blockIndex: number; score: number }[] = []
    for (const row of this.db.prepare('SELECT doc_id, block_index, vector FROM embeddings').iterate() as Iterable<{
      doc_id: string
      block_index: number
      vector: Uint8Array
    }>) {
      const vector = fromBlob(row.vector)
      if (!vector) continue
      const score = dot(query, vector)
      if (score <= 0) continue
      scored.push({ docId: row.doc_id, blockIndex: row.block_index, score })
    }
    scored.sort((a, b) => b.score - a.score)
    const top = scored.slice(0, limit)
    if (top.length === 0) return []

    const texts = new Map<string, string>()
    for (const row of this.db.prepare('SELECT doc_id, block_index, text FROM blocks').all() as {
      doc_id: string
      block_index: number
      text: string
    }[]) {
      texts.set(`${row.doc_id} ${row.block_index}`, row.text)
    }

    const hits: SemanticHit[] = []
    for (const item of top) {
      const file = this.db.prepare('SELECT path, title FROM files WHERE doc_id = ?').get(item.docId) as
        | { path: string; title: string }
        | undefined
      if (!file) continue
      const text = texts.get(`${item.docId} ${item.blockIndex}`)
      if (text === undefined) continue
      hits.push({
        docId: item.docId,
        path: file.path,
        title: file.title,
        blockIndex: item.blockIndex,
        text,
        score: item.score
      })
    }
    return hits
  }

  removeDoc(docId: string): void {
    this.deleteBlocks.run(docId)
    this.deleteMentions.run(docId)
    this.deleteEmbeddings.run(docId)
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

  /** Every occurrence of one record, newest-shaped like a search hit. */
  mentionsForEntity(request: MentionQuery): MentionHit[] {
    const clauses = ['m.entity_id = ?']
    const params: (string | number)[] = [request.entityId]
    if (request.confirmed !== undefined) {
      clauses.push('m.confirmed = ?')
      params.push(request.confirmed ? 1 : 0)
    }
    const rows = this.db
      .prepare(
        `SELECT m.doc_id, m.block_index, m.ordinal, m.surface, m.confirmed,
                m.snippet, m.snippet_start, m.snippet_end, f.path, f.title
         FROM mentions m JOIN files f ON f.doc_id = m.doc_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY m.confirmed DESC, f.path, m.block_index, m.start_offset
         LIMIT ?`
      )
      .all(...params, request.limit) as {
      doc_id: string
      block_index: number
      ordinal: number
      surface: string
      confirmed: number
      snippet: string
      snippet_start: number
      snippet_end: number
      path: string
      title: string
    }[]

    return rows.map((row) => ({
      entityId: request.entityId,
      docId: row.doc_id,
      path: row.path,
      title: row.title,
      blockIndex: row.block_index,
      ordinal: row.ordinal,
      surface: row.surface,
      confirmed: row.confirmed === 1,
      snippet: row.snippet,
      ranges: [{ start: row.snippet_start, end: row.snippet_end }]
    }))
  }

  /** Counts for every record that appears anywhere, for the list badges. */
  mentionSummary(): Record<string, MentionCounts> {
    const rows = this.db
      .prepare(
        `SELECT entity_id,
                SUM(confirmed) AS confirmed,
                SUM(1 - confirmed) AS unconfirmed,
                COUNT(DISTINCT doc_id) AS documents
         FROM mentions GROUP BY entity_id`
      )
      .all() as { entity_id: string; confirmed: number; unconfirmed: number; documents: number }[]
    const summary: Record<string, MentionCounts> = {}
    for (const row of rows) {
      summary[row.entity_id] = {
        confirmed: Number(row.confirmed),
        unconfirmed: Number(row.unconfirmed),
        documents: Number(row.documents)
      }
    }
    return summary
  }

  /**
   * Rebuild every suggestion from the indexed block text, reading no files at
   * all. This is what makes renaming a record cheap: the prose has not changed,
   * only what we are looking for in it.
   *
   * Confirmed mentions are never touched — they are anchored to marks in the
   * document rather than to a spelling, which is the whole point of storing the
   * record's id in the mark.
   *
   * Not pure SQL, because SQLite's LIKE and GLOB cannot express word
   * boundaries, possessives or the capitalisation rule. FTS narrows the work to
   * candidate blocks; the same `scanBlockText` used at index time then decides.
   */
  rescanSuggestions(): void {
    const { forms, dismissed } = this.roster()
    this.db.exec('BEGIN')
    try {
      this.db.exec('DELETE FROM mentions WHERE confirmed = 0')
      if (forms.length > 0) {
        // Same cap as indexing, and counted the same way: per record per
        // document, not per block.
        const stored = new Map<string, number>()
        for (const block of this.candidateBlocks(forms).values()) {
          const confirmed = this.confirmedRanges(block.doc_id, block.block_index)
          const silenced = dismissed.get(block.doc_id)
          for (const hit of scanBlockText(block.text, forms, confirmed)) {
            if (silenced?.has(dismissKey(hit.entityId, hit.surface))) continue
            const key = `${block.doc_id} ${hit.entityId}`
            const count = stored.get(key) ?? 0
            if (count >= MAX_SUGGESTIONS_PER_DOC) continue
            stored.set(key, count + 1)
            this.writeMention(
              block.doc_id,
              {
                blockIndex: block.block_index,
                start: hit.start,
                end: hit.end,
                entityId: hit.entityId,
                ordinal: ordinalIn(block.text, hit.surface, hit.start),
                surface: hit.surface,
                confirmed: false
              },
              block.text
            )
          }
        }
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Blocks that could contain any form, keyed so each is scanned once. */
  private candidateBlocks(
    forms: readonly ScanForm[]
  ): Map<string, { doc_id: string; block_index: number; text: string }> {
    const blocks = new Map<string, { doc_id: string; block_index: number; text: string }>()
    const expressions = new Set<string>()
    let needsFullScan = false
    for (const form of forms) {
      const expression = formMatchExpression(form.form)
      if (expression) expressions.add(expression)
      // A form with no indexable token cannot be narrowed by FTS at all.
      else needsFullScan = true
    }

    const collect = (rows: { doc_id: string; block_index: number; text: string }[]): void => {
      for (const row of rows) // The separator is an escape, not a literal NUL byte. A source file
      // containing one is treated as binary by git and by grep, which means it
      // shows no diff in review and is skipped by searches — a needless way to
      // make the largest service in the app the hardest one to read.
      blocks.set(`${row.doc_id}\u0000${row.block_index}`, row)
    }

    if (needsFullScan) {
      collect(
        this.db.prepare('SELECT doc_id, block_index, text FROM blocks').all() as never
      )
      return blocks
    }

    for (const expression of expressions) {
      try {
        collect(
          this.db
            .prepare('SELECT doc_id, block_index, text FROM blocks WHERE blocks MATCH ?')
            .all(expression) as never
        )
      } catch {
        // A form that will not compile into a MATCH expression contributes
        // nothing rather than failing the whole rescan.
      }
    }
    return blocks
  }

  private confirmedRanges(docId: string, blockIndex: number): { start: number; end: number }[] {
    const rows = this.db
      .prepare(
        'SELECT start_offset, end_offset FROM mentions WHERE doc_id = ? AND block_index = ? AND confirmed = 1'
      )
      .all(docId, blockIndex) as { start_offset: number; end_offset: number }[]
    return rows.map((row) => ({ start: row.start_offset, end: row.end_offset }))
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      // Already closed.
    }
  }
}

/** Ordinal of the occurrence at `start`, counting literal matches before it. */
function ordinalIn(text: string, surface: string, start: number): number {
  let seen = 0
  for (let i = 0; i + surface.length <= start; i++) {
    if (text.startsWith(surface, i)) seen++
  }
  return seen
}

/**
 * A MATCH expression that finds every block a form could appear in.
 *
 * Deliberately over-broad: it ANDs the form's tokens with no prefix wildcard
 * and no phrase constraint, so the false positives it lets through are then
 * rejected by the real scanner. Under-narrowing costs a little CPU; over-
 * narrowing would silently lose mentions.
 */
export function formMatchExpression(form: string): string | null {
  const terms = form.match(/[\p{L}\p{N}]+/gu)
  if (!terms || terms.length === 0) return null
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' AND ')
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
