import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { appStateSchema, type AppState, type RecentProject } from '../../shared/model/app.js'
import { keybindableCommands } from '../../shared/menu/menuModel.js'
import { findConflict, normalizeAccelerator } from '../../shared/menu/keybindings.js'
import { colorForAuthor, type AuthorProfile } from '../../shared/model/author.js'
import { ulid } from 'ulid'

const MAX_RECENTS = 12

/** Cross-window preferences and recent projects, owned by main and pushed to renderers. */
export class AppStateService {
  private state: AppState
  private readonly file: string
  private listeners = new Set<(state: AppState) => void>()

  constructor() {
    this.file = path.join(app.getPath('userData'), 'app-state.json')
    this.state = this.read()
  }

  private read(): AppState {
    const base = {
      version: app.getVersion(),
      platform: process.platform,
      recentProjects: [] as RecentProject[],
      theme: 'dark' as const
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      return appStateSchema.parse({ ...base, ...raw, version: base.version, platform: base.platform })
    } catch {
      return appStateSchema.parse(base)
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2))
    } catch {
      // Preferences are a convenience; failing to store them must not break the app.
    }
    for (const listener of this.listeners) listener(this.state)
  }

  get(): AppState {
    return this.state
  }

  onChange(listener: (state: AppState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setTheme(theme: AppState['theme']): AppState {
    this.state = { ...this.state, theme }
    this.persist()
    return this.state
  }

  setTimelineOrientation(timelineOrientation: AppState['timelineOrientation']): AppState {
    this.state = { ...this.state, timelineOrientation }
    this.persist()
    return this.state
  }

  /**
   * Turn AI on or off for this person.
   *
   * App-scoped, never project-scoped: a project is a folder people share, and
   * a collaborator who has turned AI off must not have that reversed by opening
   * someone else's manuscript. Nothing is deleted — conversations and stored
   * keys survive, so turning it back on restores them.
   */
  setAiEnabled(aiEnabled: boolean): AppState {
    this.state = { ...this.state, aiEnabled }
    this.persist()
    return this.state
  }

  /**
   * Name yourself, or pick a colour.
   *
   * The id is never taken from the caller: it is minted once on first use and
   * kept, because everything the review system writes is stamped with it, and
   * an id that could be changed from the renderer is one that could orphan
   * every comment a person has ever made.
   */
  setAuthor(changes: { name?: string; color?: string }): AppState {
    const current = this.state.author
    this.state = {
      ...this.state,
      author: {
        id: current.id || ulid(),
        name: changes.name ?? current.name,
        color: changes.color ?? current.color
      }
    }
    this.persist()
    return this.state
  }

  /** The author profile, minting an id the first time anything asks. */
  author(): AuthorProfile {
    if (!this.state.author.id) this.setAuthor({})
    const profile = this.state.author
    return { ...profile, color: profile.color || colorForAuthor(profile.id) }
  }

  setEmbeddedIdleMinutes(embeddedIdleMinutes: number): AppState {
    this.state = { ...this.state, embeddedIdleMinutes }
    this.persist()
    return this.state
  }

  /**
   * Rebind a command, or (with `null`) put it back to its default.
   *
   * Refuses rather than stores on a clash: Electron gives a duplicated
   * accelerator to whichever menu item it built first and silently drops it
   * from the other, so a conflict accepted here becomes a menu item that stops
   * working for no visible reason.
   */
  setKeybinding(
    commandId: string,
    accelerator: string | null
  ):
    | { ok: true; state: AppState }
    | { ok: false; reason: 'unknown-command' | 'invalid' }
    | { ok: false; reason: 'conflict'; conflictWith: string } {
    const bindings = keybindableCommands()
    if (!bindings.some((binding) => binding.commandId === commandId)) {
      return { ok: false, reason: 'unknown-command' }
    }

    const keybindings = { ...this.state.keybindings }
    if (accelerator === null) {
      delete keybindings[commandId]
    } else {
      const normalized = normalizeAccelerator(accelerator)
      if (!normalized) return { ok: false, reason: 'invalid' }
      const conflict = findConflict(normalized, commandId, bindings, this.state.keybindings)
      if (conflict) return { ok: false, reason: 'conflict', conflictWith: conflict.label }
      keybindings[commandId] = normalized
    }

    this.state = { ...this.state, keybindings }
    this.persist()
    return { ok: true, state: this.state }
  }

  resetKeybindings(): AppState {
    this.state = { ...this.state, keybindings: {} }
    this.persist()
    return this.state
  }

  addRecent(uri: string, name: string): void {
    const entry: RecentProject = { uri, name, opened: new Date().toISOString() }
    this.state = {
      ...this.state,
      recentProjects: [entry, ...this.state.recentProjects.filter((item) => item.uri !== uri)].slice(
        0,
        MAX_RECENTS
      )
    }
    this.persist()
  }
}
