/**
 * Vectors, stored and compared.
 *
 * Retrieval here is a brute-force cosine scan over float32 blobs — no vector
 * index, no SQLite extension. A long novel is tens of thousands of blocks,
 * which is a few milliseconds of arithmetic, and an approximate index would be
 * a second structure to keep correct in exchange for a speedup nobody can
 * perceive. That is a decision rather than an omission, and this is where it
 * lives.
 */

/**
 * Scale a vector to unit length.
 *
 * Every vector is normalised once, on the way into the database, so the cosine
 * of any pair is their dot product and the scan does one multiply-add per
 * dimension instead of three. A zero vector — which a provider can return for
 * whitespace — has no direction to preserve, so it is left alone and scores
 * zero against everything.
 */
export function normalize(vector: Float32Array): Float32Array {
  let sum = 0
  for (const value of vector) sum += value * value
  const length = Math.sqrt(sum)
  if (length === 0) return vector
  const scaled = new Float32Array(vector.length)
  for (let i = 0; i < vector.length; i++) scaled[i] = vector[i]! / length
  return scaled
}

/**
 * Cosine similarity of two already-normalised vectors.
 *
 * Vectors of differing length score zero rather than throwing: a project whose
 * embeddings were written by one model and queried by another is a state the
 * app can reach — the writer changed models — and it should degrade to "nothing
 * matches" until the index is rebuilt, not to a crash mid-search.
 */
export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let total = 0
  for (let i = 0; i < a.length; i++) total += a[i]! * b[i]!
  return total
}

/**
 * Pack a vector for storage.
 *
 * Little-endian float32, which is what every platform Quoth ships on uses
 * natively, so `fromBlob` is a view rather than a conversion. The index is a
 * rebuildable cache, so this format has no compatibility burden beyond the
 * `SCHEMA_VERSION` that guards it.
 */
export function toBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength))
}

/** Read a stored vector back. A blob that is not a whole number of floats is refused. */
export function fromBlob(blob: Uint8Array): Float32Array | null {
  if (blob.byteLength === 0 || blob.byteLength % 4 !== 0) return null
  // Copied rather than viewed: SQLite's buffer is not guaranteed to be aligned
  // to four bytes, and a misaligned Float32Array view throws.
  const copy = new Uint8Array(blob.byteLength)
  copy.set(blob)
  return new Float32Array(copy.buffer)
}
