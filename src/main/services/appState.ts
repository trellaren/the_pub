import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { appStateSchema, type AppState, type RecentProject } from '../../shared/model/app.js'

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
