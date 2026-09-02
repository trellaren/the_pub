/**
 * Format version stamped into every file The Pub writes, one counter per kind
 * of file so a breaking change to the manifest doesn't force a bump — and a
 * migration — on every `.pubdoc` that never touched the changed part.
 */
export const FORMAT_VERSIONS = {
  document: 9, // 8 = Phase 14 lang mark/attr, 9 = per-side section margins
  manifest: 9, // 7 = Phase 12 publication block, 8 = Phase 13 goals, 9 = per-side page margins
  manuscript: 1,
  entities: 2, // 2 = Phase 15 provisional flag
  beats: 1,
  maps: 1,
  layouts: 1,
  chats: 4,
  connections: 2,
  notes: 1,
  sources: 2, // 2 = Phase 15 provisional sources
  authors: 1,
  reviews: 1,
  presence: 1,
  highlights: 1,
  pdfHighlights: 2, // 2 = capture highlights (kind/offset fields)
  stats: 1
} as const
export type FileKind = keyof typeof FORMAT_VERSIONS

/** @deprecated Use `FORMAT_VERSIONS.document`. Kept so existing call sites need no churn. */
export const FORMAT_VERSION = FORMAT_VERSIONS.document

/** Project-relative directory holding all app-managed data. */
export const PUB_DIR = '.thepub'
/** Extension for manuscript documents (ProseMirror JSON envelopes). */
export const DOC_EXT = '.pubdoc'
/** Project-relative directory holding pasted/imported images. */
export const ASSETS_DIR = 'assets'

export const MANIFEST_FILE = `${PUB_DIR}/project.json`
export const LAYOUTS_FILE = `${PUB_DIR}/layouts.json`
export const SNAPSHOTS_DIR = `${PUB_DIR}/snapshots`
export const INDEX_FILE = `${PUB_DIR}/index.db`
/** Characters and locations. Kept out of the manifest: see model/entity.ts. */
export const ENTITIES_FILE = `${PUB_DIR}/entities.json`
/** Story beats, shared by the timeline and the storyboard. */
export const BEATS_FILE = `${PUB_DIR}/beats.json`
/** Vector maps, including their drill-down links. */
export const MAPS_FILE = `${PUB_DIR}/maps.json`
/** The book's structure: which documents are in it, in what order. */
export const MANUSCRIPT_FILE = `${PUB_DIR}/manuscript.json`
/** AI conversations about this manuscript. Never API keys — see AiKeyStore. */
export const CHATS_FILE = `${PUB_DIR}/chats.json`
/**
 * Notes, one file per document: `notes/<docId>.json`. Never one big file —
 * that would make a note on any document a write-conflict risk with a note
 * on any other, and a remote VFS write stays small either way.
 */
export const NOTES_DIR = `${PUB_DIR}/notes`
/**
 * Highlights, one file per document: `highlights/<docId>.json`. Mirrors
 * `NOTES_DIR` for the same reason — a highlight is a private reading act, no
 * more prone to cross-document conflict than a note is.
 */
export const HIGHLIGHTS_DIR = `${PUB_DIR}/highlights`
/**
 * Research attachments (PDFs, web captures) for a source in `sources.json`:
 * `research/<sourceId>/<attachmentId>.*`. Never under the project's own
 * folder tree — see `docs/phase-11-plan.md` — so the search indexer and file
 * tree both ignore it via `IGNORED_DIRS`' `.thepub` entry.
 */
export const RESEARCH_DIR = `${PUB_DIR}/research`
/** A CSL-JSON bibliography: every source the project can cite. */
export const SOURCES_FILE = `${PUB_DIR}/sources.json`
/**
 * Imported font files: `fonts/<id>.<ext>`. In the project, deliberately — a
 * font is part of how the manuscript looks, so it travels with the project to
 * every machine (and every remote backend) the project opens on, the same way
 * `assets/` images do. The manifest's `fonts` list is the index; the files
 * are served to the renderer over the same asset protocol as images.
 */
export const FONTS_DIR = `${PUB_DIR}/fonts`
/** Who has worked on this project: id, display name and colour. */
export const AUTHORS_FILE = `${PUB_DIR}/authors.json`
/**
 * Daily writing rollups, one file per author: `stats/<authorId>.json`. Single
 * writer by construction, same reasoning as `REVIEWS_DIR` — two people's
 * writing days must not race on one file. See `docs/phase-13-plan.md`.
 */
export const STATS_DIR = `${PUB_DIR}/stats`
/**
 * Review comments, one file per (document, author): `reviews/<docId>/<authorId>.json`.
 *
 * Not one file per document, as notes are. Notes have one writer; a review has
 * several, and two reviewers commenting on the same chapter would race on one
 * file and lose whichever save landed first. A file per pair is single-writer
 * by construction, and the read side merges the directory.
 */
export const REVIEWS_DIR = `${PUB_DIR}/reviews`
/** Heartbeats saying who has a document open. Advisory, never a lock. */
export const PRESENCE_DIR = `${PUB_DIR}/presence`

/**
 * How long a presence heartbeat is believed.
 *
 * Comfortably longer than the polling watcher's 15-second worst case plus the
 * beat interval, because the failure this tolerates — briefly showing someone
 * who has just closed a document — is nothing, and the opposite failure is a
 * collaborator flickering in and out of view.
 */
export const PRESENCE_TTL_MS = 90_000
export const PRESENCE_BEAT_MS = 30_000

/**
 * A template's own metadata, at the root of a template directory.
 *
 * Deliberately *not* under `.thepub/`: everything under that directory in a
 * template is a project file destined to be copied into the new project as-is,
 * and this file is the one thing that must not be. Keeping it a directory level
 * up is what lets `instantiate` copy `.thepub/` wholesale without a skip-list.
 */
export const TEMPLATE_MANIFEST_FILE = 'template.json'

/** Directories never scanned, indexed, or shown in the file tree. */
export const IGNORED_DIRS = [PUB_DIR, 'node_modules', '.git']

/** Autosave: save this long after the last keystroke... */
export const AUTOSAVE_DEBOUNCE_MS = 800
/** ...but never wait longer than this while the user keeps typing. */
export const AUTOSAVE_MAX_WAIT_MS = 5000

/** Only snapshot a document if this long has passed since its previous snapshot. */
export const SNAPSHOT_MIN_INTERVAL_MS = 10 * 60 * 1000
export const SNAPSHOT_MAX_PER_DOC = 50

/** Custom protocol serving project images to the renderer without file:// access. */
export const ASSET_PROTOCOL = 'pub-asset'

/** Debounce for persisting the dock layout after a change. */
export const LAYOUT_SAVE_DEBOUNCE_MS = 1000
/** Debounce for search-as-you-type. */
export const SEARCH_DEBOUNCE_MS = 250

/**
 * Debounce for writing entities.json. The record forms write straight through
 * with no draft state, so without this every keystroke in a Name field is a
 * file write *and* a project-wide mention rescan.
 */
export const ENTITY_SAVE_DEBOUNCE_MS = 600
/** Beats are edited through the same write-through forms; same reasoning. */
export const BEAT_SAVE_DEBOUNCE_MS = 600
/** Drawing emits changes far faster than typing, so maps wait a little longer. */
export const MAP_SAVE_DEBOUNCE_MS = 800
/** A note's body is edited the same write-through way; same reasoning. */
export const NOTE_SAVE_DEBOUNCE_MS = 600
/**
 * Word-count deltas accumulate in memory (see `statsService.ts`) and flush to
 * disk on this debounce, not per edit — a day of writing should cost a
 * handful of writes, not one per keystroke.
 */
export const STATS_SAVE_DEBOUNCE_MS = 5000
/** How long since the last edit before an active writing session is considered over. */
export const STATS_IDLE_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Shortest name or alias the scanner will look for. A character called "Al"
 * would otherwise match half the manuscript; short names stay reachable
 * through an explicit @-mention, which is the authoritative source anyway.
 */
export const MIN_SCAN_LENGTH = 3

/**
 * Cap on unconfirmed suggestions stored per (entity, document). The true count
 * is still reported in the summary — this only bounds what the index holds for
 * a name that appears on every page.
 */
export const MAX_SUGGESTIONS_PER_DOC = 50
