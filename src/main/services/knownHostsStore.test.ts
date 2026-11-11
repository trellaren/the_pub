import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { FORMAT_VERSIONS } from '../../shared/constants.js'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))

const { KnownHostsStore } = await import('./knownHostsStore.js')

const KEY = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:abc' }
let dir: string
let file: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-known-hosts-'))
  file = path.join(dir, 'known_hosts.json')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('KnownHostsStore', () => {
  it('trusts and reads back a key', () => {
    const store = new KnownHostsStore(file)
    store.trust('host-a', KEY)
    expect(store.get('host-a')).toMatchObject([KEY])
  })

  it('sets a corrupt file aside instead of overwriting it with one host', () => {
    fs.writeFileSync(file, '{ "hosts": { "host-a": [')
    const store = new KnownHostsStore(file)
    expect(store.get('host-a')).toEqual([])
    const names = fs.readdirSync(dir)
    expect(names.some((name) => name.startsWith('known_hosts.json.corrupt-'))).toBe(true)
  })

  it('reads a newer build’s file but refuses to rewrite it', () => {
    const newer = JSON.stringify({
      formatVersion: FORMAT_VERSIONS.knownHosts + 1,
      hosts: { 'host-a': [{ ...KEY, added: '2026-01-01T00:00:00.000Z' }] }
    })
    fs.writeFileSync(file, newer)
    const store = new KnownHostsStore(file)
    expect(store.get('host-a')).toMatchObject([KEY])
    expect(() => store.trust('host-b', KEY)).toThrow(/newer version/)
    expect(() => store.forget('host-a')).toThrow(/newer version/)
    expect(fs.readFileSync(file, 'utf8')).toBe(newer)
  })
})
