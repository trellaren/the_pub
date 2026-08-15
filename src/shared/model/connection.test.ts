import { describe, it, expect } from 'vitest'
import {
  connectionProfileSchema,
  connectionFileSchema,
  defaultPort,
  projectUri,
  parseProjectUri,
  describeConnection,
  isSignedIn,
  type ConnectionProfile
} from './connection.js'

function profile(patch: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return connectionProfileSchema.parse({
    id: 'p1',
    name: 'Test',
    protocol: 'sftp',
    host: 'files.example.com',
    port: 22,
    user: 'writer',
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    ...patch
  })
}

describe('connectionProfileSchema', () => {
  it('defaults to password auth with no stored secret', () => {
    const parsed = profile()
    expect(parsed.auth).toBe('password')
    expect(parsed.hasSecret).toBe(false)
    expect(parsed.remotePath).toBe('/')
  })

  it('has no field that could carry a secret', () => {
    // The profile crosses to the renderer; the password must not be able to.
    expect(Object.keys(profile())).not.toContain('password')
    expect(Object.keys(profile())).not.toContain('secret')
  })

  it('rejects an impossible port', () => {
    expect(connectionProfileSchema.safeParse({ ...profile(), port: 0 }).success).toBe(false)
    expect(connectionProfileSchema.safeParse({ ...profile(), port: 70_000 }).success).toBe(false)
  })

  it('parses an empty file into no servers', () => {
    expect(connectionFileSchema.parse({}).connections).toEqual([])
  })
})

describe('defaultPort', () => {
  it('knows the standard ports', () => {
    expect(defaultPort('sftp')).toBe(22)
    expect(defaultPort('ftp')).toBe(21)
    // OneDrive has no port to choose, but the schema demands a legal one.
    expect(defaultPort('onedrive')).toBe(443)
  })
})

describe('a OneDrive profile', () => {
  it('carries the app registration rather than a host and a user', () => {
    const drive = profile({ protocol: 'onedrive', host: '', user: '', port: 443 })
    expect(drive.clientId).toBe('')
    expect(drive.tenant).toBe('common')
    expect(drive.account).toBe('')
  })

  it('has nowhere to keep a token either', () => {
    // The refresh token lives with the passwords: encrypted, in userData, and
    // out of reach of every channel.
    const keys = Object.keys(profile({ protocol: 'onedrive' }))
    expect(keys).not.toContain('refreshToken')
    expect(keys).not.toContain('accessToken')
  })

  it('is signed in exactly when a token is stored for it', () => {
    expect(isSignedIn(profile({ protocol: 'onedrive', hasSecret: true }))).toBe(true)
    expect(isSignedIn(profile({ protocol: 'onedrive', hasSecret: false }))).toBe(false)
    // A stored SFTP password is not a sign-in.
    expect(isSignedIn(profile({ hasSecret: true }))).toBe(false)
  })
})

describe('project URIs', () => {
  it('names the profile by id, not by host', () => {
    // Hosts, ports and users all change; a reference that breaks when a server
    // moves is a reference nobody trusts.
    expect(projectUri(profile())).toBe('sftp://p1')
    expect(projectUri(profile({ protocol: 'ftp' }))).toBe('ftp://p1')
  })

  it('carries a path so one server can hold several projects', () => {
    expect(projectUri(profile(), '/books/one/')).toBe('sftp://p1/books/one')
  })

  it('round-trips', () => {
    expect(parseProjectUri(projectUri(profile(), 'books/one'))).toEqual({
      profileId: 'p1',
      path: 'books/one'
    })
    expect(parseProjectUri(projectUri(profile()))).toEqual({ profileId: 'p1', path: '' })
  })

  it('treats a OneDrive project the same way', () => {
    const drive = profile({ protocol: 'onedrive' })
    expect(projectUri(drive, 'Documents/Novel')).toBe('onedrive://p1/Documents/Novel')
    expect(parseProjectUri('onedrive://p1/Documents/Novel')).toEqual({
      profileId: 'p1',
      path: 'Documents/Novel'
    })
  })

  it('declines anything that is not a remote project', () => {
    expect(parseProjectUri('/home/writer/book')).toBeNull()
    expect(parseProjectUri('file:///home/writer/book')).toBeNull()
    expect(parseProjectUri('dropbox://something')).toBeNull()
  })
})

describe('describeConnection', () => {
  it('reads like a place', () => {
    expect(describeConnection(profile({ remotePath: '/srv/books' }))).toBe(
      'writer@files.example.com/srv/books'
    )
  })

  it('prefers the path the project was opened at', () => {
    expect(describeConnection(profile({ remotePath: '/srv' }), 'books/one')).toBe(
      'writer@files.example.com/books/one'
    )
  })

  it('names a OneDrive project by its account', () => {
    const drive = profile({ protocol: 'onedrive', host: '', user: '', account: 'you@outlook.com' })
    expect(describeConnection(drive, 'Documents/Novel')).toBe('you@outlook.com/Documents/Novel')
    // The drive root is the whole drive, so there is no path worth appending.
    expect(describeConnection(drive)).toBe('you@outlook.com')
  })

  it('says something readable before anyone has signed in', () => {
    expect(describeConnection(profile({ protocol: 'onedrive', host: '', user: '' }))).toBe('OneDrive')
  })
})
