/** Format version stamped into every file The Pub writes. Bump on breaking changes. */
export const FORMAT_VERSION = 1

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
