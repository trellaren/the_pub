import { Buffer } from 'buffer'

/*
 * Desktop modules read `process` and `Buffer` as they are evaluated, so this
 * has to be the first import of the worker's entry point.
 */

type BufferFrom = (value: unknown, encoding?: string, length?: number) => Buffer

/**
 * The browser `Buffer` predates Node's `base64url` encoding, which the OAuth
 * code uses for PKCE. Both directions are the base64 it does have, re-lettered.
 */
export function addBase64Url(target: typeof Buffer): void {
  const toString = target.prototype.toString
  target.prototype.toString = function (this: Buffer, encoding?: string, start?: number, end?: number): string {
    if (encoding !== 'base64url') return toString.call(this, encoding as BufferEncoding, start, end)
    return toString.call(this, 'base64', start, end).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  } as typeof toString

  const from = target.from.bind(target) as BufferFrom
  ;(target as unknown as { from: BufferFrom }).from = (value, encoding, length) =>
    typeof value === 'string' && encoding === 'base64url'
      ? from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
      : from(value, encoding, length)
}

addBase64Url(Buffer)

const scope = globalThis as unknown as { Buffer: typeof Buffer; process: unknown }
scope.Buffer = Buffer
scope.process = { platform: 'ios', arch: 'arm64', env: {}, versions: {}, resourcesPath: '/resources' }
