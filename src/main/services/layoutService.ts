import { ulid } from 'ulid'
import type { VfsAdapter } from '../vfs/types.js'
import { layoutFileSchema, type LayoutFile, type LayoutPreset, type DockLayout } from '../../shared/model/layout.js'
import { LAYOUTS_FILE, FORMAT_VERSIONS } from '../../shared/constants.js'
import { readVersionedJson, SerialQueue, jsonBytes, type VersionedRead } from './versionedJson.js'

const EMPTY: LayoutFile = { formatVersion: FORMAT_VERSIONS.layouts, lastLayout: null, presets: [] }

/** Persists the dock arrangement — including popout windows, which dockview serializes inline. */
export class LayoutService {
  constructor(private readonly adapter: VfsAdapter) {}

  /** A newer build wrote the file; saves are then skipped rather than strip it. */
  private tooNew = false
  /**
   * Every save is a read-modify-write of the whole file; two overlapping ones
   * (an autosave of the dock and a preset saved at the same moment) would
   * otherwise each write back a copy missing the other's change.
   */
  private readonly queue = new SerialQueue()

  private async read(): Promise<VersionedRead<LayoutFile>> {
    const read = await readVersionedJson(this.adapter, LAYOUTS_FILE, 'layouts', layoutFileSchema, () =>
      structuredClone(EMPTY)
    )
    this.tooNew = read.tooNew
    return read
  }

  async load(): Promise<LayoutFile> {
    try {
      return (await this.read()).value
    } catch {
      // An unreachable layout file must never block opening a project; the
      // renderer falls back to the default arrangement.
      return structuredClone(EMPTY)
    }
  }

  /**
   * A read failure here propagates rather than falling back to empty, unlike
   * `load`: writing an empty file over one that merely could not be read
   * would delete every saved preset.
   */
  private async update<T>(change: (file: LayoutFile) => T): Promise<T> {
    return this.queue.run(async () => {
      const { value: file } = await this.read()
      const result = change(file)
      // Skipped quietly, not thrown: the layout autosaves on every dock change, and
      // an error each time would be noise about a convenience, not lost work.
      if (this.tooNew) return result
      file.formatVersion = FORMAT_VERSIONS.layouts
      await this.adapter.writeFileAtomic(LAYOUTS_FILE, jsonBytes(file))
      return result
    })
  }

  async saveLast(layout: DockLayout): Promise<void> {
    await this.update((file) => {
      file.lastLayout = layout
    })
  }

  async savePreset(name: string, layout: DockLayout): Promise<LayoutPreset> {
    return this.update((file) => {
      const existing = file.presets.find((preset) => preset.name === name)
      const preset: LayoutPreset = {
        id: existing?.id ?? ulid(),
        name,
        created: new Date().toISOString(),
        layout
      }
      file.presets = [...file.presets.filter((item) => item.id !== preset.id), preset]
      return preset
    })
  }

  async deletePreset(id: string): Promise<void> {
    await this.update((file) => {
      file.presets = file.presets.filter((preset) => preset.id !== id)
    })
  }
}
