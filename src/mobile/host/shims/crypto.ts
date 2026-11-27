import { Buffer } from 'buffer'
import { sha256 } from '@noble/hashes/sha2.js'
import { sha1 } from '@noble/hashes/legacy.js'

type Hasher = ReturnType<typeof sha256.create>

class Hash {
  constructor(private readonly hasher: Hasher) {}
  update(data: string | Uint8Array): this {
    this.hasher.update(typeof data === 'string' ? new TextEncoder().encode(data) : data)
    return this
  }
  digest(): Buffer
  digest(encoding: BufferEncoding): string
  digest(encoding?: BufferEncoding): Buffer | string {
    const bytes = Buffer.from(this.hasher.digest())
    return encoding ? bytes.toString(encoding) : bytes
  }
}

const ALGORITHMS: Record<string, () => Hasher> = {
  sha256: () => sha256.create(),
  sha1: () => sha1.create() as unknown as Hasher
}

export function createHash(algorithm: string): Hash {
  const create = ALGORITHMS[algorithm]
  if (!create) throw new Error(`Unsupported hash on this platform: ${algorithm}`)
  return new Hash(create())
}

export function randomBytes(size: number): Buffer {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(size)))
}

export function randomUUID(): string {
  return crypto.randomUUID()
}

export default { createHash, randomBytes, randomUUID }
