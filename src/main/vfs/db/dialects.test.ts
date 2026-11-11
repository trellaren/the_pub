import { describe, expect, it } from 'vitest'
import { tlsFor } from './dialects.js'

describe('tlsFor', () => {
  it.each(['db.example.com', '10.0.0.5', 'my-server'])('requires a verified certificate for %s', (host) => {
    expect(tlsFor(host)).toEqual({ rejectUnauthorized: true })
  })

  it.each(['localhost', 'LOCALHOST', '127.0.0.1', '::1', 'dev.localhost'])('leaves loopback %s unencrypted', (host) => {
    expect(tlsFor(host)).toBeUndefined()
  })
})
