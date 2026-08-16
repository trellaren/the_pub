import { describe, it, expect } from 'vitest'
import { normalize, dot, toBlob, fromBlob } from './vectors.js'

describe('normalize', () => {
  it('scales to unit length', () => {
    const unit = normalize(new Float32Array([3, 4]))
    expect(dot(unit, unit)).toBeCloseTo(1, 5)
  })

  it('leaves a zero vector alone rather than dividing by zero', () => {
    const zero = normalize(new Float32Array([0, 0, 0]))
    expect([...zero]).toEqual([0, 0, 0])
  })
})

describe('dot', () => {
  it('is 1 for identical directions and 0 for orthogonal ones', () => {
    const a = normalize(new Float32Array([1, 1]))
    const b = normalize(new Float32Array([2, 2]))
    const c = normalize(new Float32Array([1, -1]))
    expect(dot(a, b)).toBeCloseTo(1, 5)
    expect(dot(a, c)).toBeCloseTo(0, 5)
  })

  it('scores zero across differing lengths instead of throwing', () => {
    // The state this covers is real: change the embedding model and the stored
    // vectors have the old width until the index is rebuilt. Nothing matches,
    // which is the honest answer; a crash mid-search would not be.
    expect(dot(new Float32Array([1, 0]), new Float32Array([1, 0, 0]))).toBe(0)
  })
})

describe('blobs', () => {
  it('round-trips a vector', () => {
    const vector = new Float32Array([0.5, -0.25, 0.125])
    const read = fromBlob(toBlob(vector))
    expect(read && [...read]).toEqual([0.5, -0.25, 0.125])
  })

  it('reads a misaligned buffer, which is what SQLite can hand back', () => {
    const vector = new Float32Array([1, 2])
    const padded = new Uint8Array(toBlob(vector).byteLength + 1)
    padded.set(toBlob(vector), 1)
    const read = fromBlob(padded.subarray(1))
    expect(read && [...read]).toEqual([1, 2])
  })

  it('refuses a blob that is not whole floats', () => {
    expect(fromBlob(new Uint8Array([1, 2, 3]))).toBeNull()
    expect(fromBlob(new Uint8Array(0))).toBeNull()
  })
})
