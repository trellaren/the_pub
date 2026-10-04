import { ulid } from 'ulid'
import type { VfsAdapter } from '../vfs/types.js'
import { layoutFileSchema, type LayoutFile, type LayoutPreset, type DockLayout } from '../../shared/model/layout.js'
import { LAYOUTS_FILE, FORMAT_VERSIONS } from '../../shared/constants.js'
import { migrate } from '../../shared/model/migrate.js'

const EMPTY: LayoutFile = { formatVersion: FORMAT_VERSIONS.layouts, lastLayout: null, presets: [] }

/** Persists the dock arrangement — including popout windows, which dockview serializes inline. */
export class LayoutService {
  constructor(private readonly adapter: VfsAdapter) {}

  /** A newer build wrote the file; saves are then skipped rather than strip it. */
  private tooNew = false

  async load(): Promise<LayoutFile> {
    try {
      const raw = await this.adapter.readFile(LAYOUTS_FILE)
      const { value, tooNew } = migrate('layouts', JSON.parse(raw.toString('utf8')))
      this.tooNew = tooNew
      return layoutFileSchema.parse(value)
    } catch {
      // A corrupt or missing layout file must never block opening a project;
      // the renderer falls back to the default arrangement.
      return { ...EMPTY }
    }
  }

  private async save(file: LayoutFile): Promise<void> {
    // Skipped quietly, not thrown: the layout autosaves on every dock change, and
    // an error each time would be noise about a convenience, not lost work.
    if (this.tooNew) return
    file.formatVersion = FORMAT_VERSIONS.layouts
    await this.adapter.writeFileAtomic(LAYOUTS_FILE, Buffer.from(JSON.stringify(file, null, 2), 'utf8'))
  }

  async saveLast(layout: DockLayout): Promise<void> {
    const file = await this.load()
    file.lastLayout = layout
    await this.save(file)
  }

  async savePreset(name: string, layout: DockLayout): Promise<LayoutPreset> {
    const file = await this.load()
    const existing = file.presets.find((preset) => preset.name === name)
    const preset: LayoutPreset = {
      id: existing?.id ?? ulid(),
      name,
      created: new Date().toISOString(),
      layout
    }
    file.presets = [...file.presets.filter((item) => item.id !== preset.id), preset]
    await this.save(file)
    return preset
  }

  async deletePreset(id: string): Promise<void> {
    const file = await this.load()
    file.presets = file.presets.filter((preset) => preset.id !== id)
    await this.save(file)
  }
}
