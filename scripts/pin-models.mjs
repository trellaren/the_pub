#!/usr/bin/env node
/**
 * Pin the catalogue's model files.
 *
 * Reads every variant's `source` from the catalogue, asks the hub for that
 * exact revision's file listing, and writes the real size and SHA-256 into
 * `src/shared/model/modelPins.ts`.
 *
 *   npm run pin-models              # pin everything the catalogue names
 *   npm run pin-models -- bonsai-9b-q4_k_m
 *
 * Why this is a script and not a chore:
 *
 * - A digest copied off a web page by a person is one nobody can re-derive, and
 *   one copied *wrongly* makes every download look tampered with — the failure
 *   is indistinguishable from an attack, which is the worst way to be wrong.
 * - The size shown on the download button and used for the disk preflight is
 *   otherwise an estimate somebody guessed. Here it is the file's real length.
 * - Re-running it after a revision changes is a one-line diff to review, so
 *   updating a model is an ordinary reviewable change.
 *
 * The digest comes from the hub's LFS `oid`, which is the SHA-256 of the file
 * content. That and the pinned commit revision are checked against each other:
 * a revision naming a branch is refused, because a branch downloads whatever is
 * there today rather than the file this digest was taken from.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pinsFile = path.join(root, 'src/shared/model/modelPins.ts')

/** A commit hash, as opposed to a branch or tag name. */
function isCommitHash(revision) {
  return /^[0-9a-f]{40}$/i.test(revision)
}

async function loadCatalogue() {
  // Read the source rather than importing it: the catalogue is TypeScript, and
  // this script must run with no build step in front of it.
  const source = await fs.readFile(path.join(root, 'src/shared/model/llm.ts'), 'utf8')
  const variants = []
  const pattern =
    /id:\s*'([^']+)',[\s\S]{0,200}?source:\s*\{\s*repo:\s*'([^']*)',\s*revision:\s*'([^']*)',\s*file:\s*'([^']*)'\s*\}/g
  let match
  while ((match = pattern.exec(source)) !== null) {
    variants.push({ id: match[1], repo: match[2], revision: match[3], file: match[4] })
  }
  return variants
}

async function pin(variant) {
  if (!variant.revision) {
    return { ok: false, reason: 'no revision pinned in the catalogue' }
  }
  if (!isCommitHash(variant.revision)) {
    // A branch or tag would let the bytes change under a digest that no longer
    // describes them, which is exactly the failure pinning exists to prevent.
    return { ok: false, reason: `revision "${variant.revision}" is not a commit hash` }
  }

  const url = `https://huggingface.co/api/models/${variant.repo}/tree/${variant.revision}`
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  if (!response.ok) {
    return { ok: false, reason: `${url} returned ${response.status}` }
  }

  const entries = await response.json()
  const entry = Array.isArray(entries) ? entries.find((item) => item?.path === variant.file) : null
  if (!entry) return { ok: false, reason: `no file "${variant.file}" at that revision` }

  const sha256 = entry.lfs?.oid ?? ''
  const bytes = entry.lfs?.size ?? entry.size ?? 0
  if (!/^[0-9a-f]{64}$/i.test(sha256)) {
    // A file stored outside LFS has no published digest to pin. Better to say
    // so than to invent one from a download this script would have to make.
    return { ok: false, reason: 'the hub publishes no SHA-256 for that file' }
  }
  return { ok: true, bytes, sha256: sha256.toLowerCase() }
}

async function main() {
  const wanted = process.argv.slice(2)
  const variants = (await loadCatalogue()).filter(
    (variant) => wanted.length === 0 || wanted.includes(variant.id)
  )
  if (variants.length === 0) {
    console.error('No matching variants in the catalogue.')
    process.exitCode = 1
    return
  }

  const pins = {}
  const failures = []
  for (const variant of variants) {
    const result = await pin(variant).catch((error) => ({ ok: false, reason: String(error) }))
    if (result.ok) {
      pins[variant.id] = { bytes: result.bytes, sha256: result.sha256 }
      console.log(`pinned  ${variant.id}  ${result.bytes} bytes  ${result.sha256.slice(0, 16)}…`)
    } else {
      failures.push(`${variant.id}: ${result.reason}`)
      console.warn(`skipped ${variant.id}  (${result.reason})`)
    }
  }

  // Merged rather than replaced when pinning a subset, so pinning one variant
  // does not silently unpin the rest.
  const existing = await fs.readFile(pinsFile, 'utf8')
  const previous = Object.fromEntries(
    [...existing.matchAll(/'([^']+)':\s*\{\s*bytes:\s*(\d+),\s*sha256:\s*'([0-9a-f]*)'\s*\}/g)].map(
      (entry) => [entry[1], { bytes: Number(entry[2]), sha256: entry[3] }]
    )
  )
  const merged = { ...previous, ...pins }

  const header = existing.slice(0, existing.indexOf('export const MODEL_PINS'))
  const body = Object.keys(merged)
    .sort()
    .map((id) => `  '${id}': { bytes: ${merged[id].bytes}, sha256: '${merged[id].sha256}' }`)
    .join(',\n')
  await fs.writeFile(
    pinsFile,
    `${header}export const MODEL_PINS: Record<string, ModelPin> = {\n${body}${body ? '\n' : ''}}\n`
  )

  console.log(`\nWrote ${Object.keys(merged).length} pin(s) to ${path.relative(root, pinsFile)}.`)
  if (failures.length > 0) {
    console.log(`\n${failures.length} variant(s) could not be pinned:`)
    for (const failure of failures) console.log(`  - ${failure}`)
    console.log('\nThose report as unverified in the app until they are pinned.')
    process.exitCode = 1
  }
}

await main()
