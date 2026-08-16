import { z } from 'zod'
import { FORMAT_VERSIONS } from '../constants.js'

/**
 * A saved server a project can live on.
 *
 * The profile holds everything except the secret. Passwords and key
 * passphrases are stored separately and encrypted, and never travel to the
 * renderer — the same rule the AI keys follow, for the same reason.
 */
export const connectionProtocols = ['sftp', 'ftp', 'onedrive'] as const
export const connectionProtocolSchema = z.enum(connectionProtocols)
export type ConnectionProtocol = z.infer<typeof connectionProtocolSchema>

export const connectionAuthSchema = z.enum(['password', 'key'])
export type ConnectionAuth = z.infer<typeof connectionAuthSchema>

export const connectionProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  protocol: connectionProtocolSchema,
  /** Empty for OneDrive, which has one well-known host nobody types. */
  host: z.string(),
  port: z.number().int().min(1).max(65_535),
  /** Empty for OneDrive: the account comes from signing in, not from typing. */
  user: z.string(),
  auth: connectionAuthSchema.default('password'),
  /** Path to a private key file on this machine, for key auth. */
  privateKeyPath: z.string().default(''),
  /** Directory on the server that becomes the project root. */
  remotePath: z.string().default('/'),
  /** FTP only: explicit TLS. Always on for SFTP, which is SSH. */
  secure: z.boolean().default(false),
  /**
   * OneDrive only: the Application (client) ID of an Azure app registration.
   *
   * Supplied by whoever runs the app rather than baked in, for the same reason
   * the AI keys are: a client id shipped inside a desktop binary is a public
   * value that anyone can lift and spend someone else's tenant quota with, and
   * it cannot be rotated without shipping a new build.
   */
  clientId: z.string().default(''),
  /** OneDrive only: `common`, `consumers`, `organizations`, or a tenant GUID. */
  tenant: z.string().default('common'),
  /** OneDrive only: the signed-in account, written by sign-in and shown back. */
  account: z.string().default(''),
  /** True when a secret is stored for this profile; never the secret itself. */
  hasSecret: z.boolean().default(false),
  created: z.string(),
  modified: z.string()
})
export type ConnectionProfile = z.infer<typeof connectionProfileSchema>

/**
 * An SSH host key the author is being asked about.
 *
 * The only host-key detail that reaches the renderer, and it is all display:
 * the fingerprint is a value meant to be read and compared by a person, and
 * accepting one is a separate act on a channel that names the profile. The key
 * bytes themselves never leave the main process.
 */
export const untrustedHostKeySchema = z.object({
  /** e.g. `ssh-ed25519`. */
  algorithm: z.string(),
  /** OpenSSH's `SHA256:…` form, so it can be compared with `ssh-keygen -lf`. */
  fingerprint: z.string(),
  /** `unknown` on a first connection; `changed` when a stored key disagrees. */
  verdict: z.enum(['unknown', 'changed']),
  /** The fingerprint previously accepted, when this is a change. */
  previous: z.string().default('')
})
export type UntrustedHostKey = z.infer<typeof untrustedHostKeySchema>

export const connectionFileSchema = z.object({
  formatVersion: z.number().int().default(FORMAT_VERSIONS.connections),
  connections: z.array(connectionProfileSchema).default(() => [])
})
export type ConnectionFile = z.infer<typeof connectionFileSchema>

export function defaultPort(protocol: ConnectionProtocol): number {
  if (protocol === 'sftp') return 22
  if (protocol === 'ftp') return 21
  // OneDrive is HTTPS to a fixed endpoint and has no port to choose. The field
  // is required by the schema, so it holds the port that is actually used.
  return 443
}

/** OneDrive stores an OAuth refresh token where the others store a password. */
export function isSignedIn(profile: ConnectionProfile): boolean {
  return profile.protocol === 'onedrive' && profile.hasSecret
}

/**
 * The URI a project on this server is opened by.
 *
 * The profile id rather than the host and user: credentials, ports and even the
 * hostname can change, and a project reference that breaks when a server moves
 * is a project reference nobody trusts. Recent-project lists and saved layouts
 * all key off this string.
 */
export function projectUri(profile: ConnectionProfile, path = ''): string {
  const clean = path.replace(/^\/+|\/+$/g, '')
  return `${profile.protocol}://${profile.id}${clean ? `/${clean}` : ''}`
}

/** Take a project URI back apart. Returns null for anything not remote. */
export function parseProjectUri(uri: string): { profileId: string; path: string } | null {
  const match = /^(sftp|ftp|onedrive):\/\/([^/]+)(?:\/(.*))?$/i.exec(uri)
  if (!match) return null
  return { profileId: match[2]!, path: match[3] ?? '' }
}

/** What to show in a window title or a recents list. */
export function describeConnection(profile: ConnectionProfile, path = ''): string {
  const where = path ? `/${path.replace(/^\/+/, '')}` : profile.remotePath
  // There is no host or user to show for OneDrive: the account is the whole
  // address, and `@graph.microsoft.com` would be noise in every window title.
  if (profile.protocol === 'onedrive') {
    return `${profile.account || 'OneDrive'}${where === '/' ? '' : where}`
  }
  return `${profile.user}@${profile.host}${where}`
}
