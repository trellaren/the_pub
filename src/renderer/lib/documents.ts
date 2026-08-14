/**
 * Tracks every window this app renders into — the main one plus any dockview
 * popouts.
 *
 * Popouts share the opener's JS context but have their own `document`, so
 * anything applied imperatively to the DOM (the generated named-style sheet, the
 * theme attribute) has to be applied to each of them. Dockview copies existing
 * stylesheets when a popout opens; this registry handles everything that changes
 * afterwards.
 */
const documents = new Set<Document>()
const appliers = new Set<(target: Document) => void>()

export function registerDocument(target: Document): void {
  if (documents.has(target)) return
  documents.add(target)
  for (const apply of appliers) apply(target)
}

export function unregisterDocument(target: Document): void {
  documents.delete(target)
}

export function allDocuments(): Document[] {
  return [...documents]
}

/**
 * Register an effect that must hold in every window. It runs immediately for
 * known windows and again whenever a new popout opens.
 */
export function registerDocumentEffect(apply: (target: Document) => void): () => void {
  appliers.add(apply)
  for (const target of documents) apply(target)
  return () => appliers.delete(apply)
}

export function applyToAllDocuments(apply: (target: Document) => void): void {
  for (const target of documents) apply(target)
}

/** Create or update a named `<style>` element in one window. */
export function setStyleElement(target: Document, id: string, css: string): void {
  let element = target.getElementById(id) as HTMLStyleElement | null
  if (!element) {
    element = target.createElement('style')
    element.id = id
    target.head.appendChild(element)
  }
  if (element.textContent !== css) element.textContent = css
}

registerDocument(document)
