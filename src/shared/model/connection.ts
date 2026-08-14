import { z } from 'zod'
import { FORMAT_VERSION } from '../constants.js'

/**
 * A saved server a project can live on.
 *
 * The profile holds everything except the secret. Passwords and key
 * passphrases are stored separately and encrypted, and never travel to the
 * renderer — the same rule the AI keys follow, for the same reason.
 */
export const connectionProtocols = ['sftp', 'ftp'] as const
export const connectionProtocolSchema = z.enum(connectionProtocols)
export type ConnectionProtocol = z.infer<typeof connectionProtocolSchema>

export const connectionAuthSchema = z.enum(['password', 'key'])
export type ConnectionAuth = z.infer<typeof connectionAuthSchema>

export const connectionProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  protocol: connectionProtocolSchema,
  host: z.string(),
  port: z.number().int().min(1).max(65_535),
  user: z.string(),
  auth: connectionAuthSchema.default('password'),
  /** Path to a private key file on this machine, for key auth. */
  privateKeyPath: z.string().default(''),
  /** Directory on the server that becomes the project root. */
  remotePath: z.string().default('/'),
  /** FTP only: explicit TLS. Always on for SFTP, which is SSH. */
  secure: z.boolean().default(false),
  /** True when a secret is stored for this profile; never the secret itself. */
  hasSecret: z.boolean().default(false),
  created: z.string(),
  modified: z.string()
})
export type ConnectionProfile = z.infer<typeof connectionProfileSchema>

export const connectionFileSchema = z.object({
  formatVersion: z.number().int().default(FORMAT_VERSION),
  connections: z.array(connectionProfileSchema).default(() => [])
})
export type ConnectionFile = z.infer<typeof connectionFileSchema>

export function defaultPort(protocol: ConnectionProtocol): number {
  return protocol === 'sftp' ? 22 : 21
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
  const match = /^(sftp|ftp):\/\/([^/]+)(?:\/(.*))?$/i.exec(uri)
  if (!match) return null
  return { profileId: match[2]!, path: match[3] ?? '' }
}

/** What to show in a window title or a recents list. */
export function describeConnection(profile: ConnectionProfile, path = ''): string {
  const where = path ? `/${path.replace(/^\/+/, '')}` : profile.remotePath
  return `${profile.user}@${profile.host}${where}`
}
