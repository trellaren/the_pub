import { create } from 'zustand'
import { ulid } from 'ulid'
import type { StoryMap, MapShape, MapShapeKind, Point } from '@shared/model/map.js'
import { DEFAULT_STROKE_WIDTH, DEFAULT_AREA_OPACITY } from '@shared/model/map.js'
import { MAP_SAVE_DEBOUNCE_MS } from '@shared/constants.js'
import { invoke, attempt } from '@renderer/lib/ipc.js'

export interface CreateMapOptions {
  background?: string | null
  width?: number
  height?: number
}

interface MapStore {
  maps: StoryMap[]
  activeMapId: string | null
  loaded: boolean
  load: () => Promise<void>
  setActive: (id: string | null) => void
  create: (name: string, options?: CreateMapOptions) => Promise<StoryMap | null>
  remove: (id: string) => Promise<void>
  rename: (id: string, name: string) => void
  /**
   * Swap or clear the underlay. Passing a size adopts the image's box; leaving
   * it out keeps the map's own — which is what a map with shapes on it wants,
   * because adopting new dimensions would silently move every placed marker.
   */
  setBackground: (id: string, background: string | null, size?: { width: number; height: number }) => void
  addShape: (mapId: string, kind: MapShapeKind, points: Point[], text?: string) => MapShape | null
  patchShape: (mapId: string, shapeId: string, changes: Partial<MapShape>) => void
  removeShape: (mapId: string, shapeId: string) => void
  flush: () => Promise<void>
}

const pending = new Map<string, ReturnType<typeof setTimeout>>()

export const useMapStore = create<MapStore>((set, get) => ({
  maps: [],
  activeMapId: null,
  loaded: false,

  load: async () => {
    const file = await attempt(invoke('maps:list', {}), 'Could not load maps')
    if (!file) return
    set({
      maps: file.maps,
      loaded: true,
      activeMapId: get().activeMapId ?? file.maps[0]?.id ?? null
    })
  },

  setActive: (id) => set({ activeMapId: id }),

  create: async (name, options = {}) => {
    const map = await attempt(
      invoke('maps:create', {
        name,
        background: options.background ?? null,
        width: options.width,
        height: options.height
      }),
      'Could not create the map'
    )
    if (!map) return null
    set({ maps: [...get().maps, map], activeMapId: map.id })
    return map
  },

  remove: async (id) => {
    cancel(id)
    await attempt(invoke('maps:delete', { id }), 'Could not delete the map')
    // Main also clears links pointing at the deleted map, so take its word.
    const file = await invoke('maps:list', {}).catch(() => null)
    if (file) {
      set({
        maps: file.maps,
        activeMapId: get().activeMapId === id ? (file.maps[0]?.id ?? null) : get().activeMapId
      })
    }
  },

  rename: (id, name) => patchMap(set, get, id, (map) => ({ ...map, name })),

  setBackground: (id, background, size) =>
    patchMap(set, get, id, (map) => ({ ...map, background, ...(size ?? {}) })),

  addShape: (mapId, kind, points, text = '') => {
    const shape: MapShape = {
      id: ulid(),
      kind,
      text,
      points,
      // The defaults; the panel patches in how it was actually drawn a moment
      // later, the same way it already did for colour.
      icon: null,
      strokeWidth: DEFAULT_STROKE_WIDTH,
      opacity: DEFAULT_AREA_OPACITY,
      entityId: null,
      childMapId: null,
      notes: ''
    }
    patchMap(set, get, mapId, (map) => ({ ...map, shapes: [...map.shapes, shape] }))
    return shape
  },

  patchShape: (mapId, shapeId, changes) =>
    patchMap(set, get, mapId, (map) => ({
      ...map,
      shapes: map.shapes.map((shape) => (shape.id === shapeId ? { ...shape, ...changes } : shape))
    })),

  removeShape: (mapId, shapeId) =>
    patchMap(set, get, mapId, (map) => ({
      ...map,
      shapes: map.shapes.filter((shape) => shape.id !== shapeId)
    })),

  flush: async () => {
    for (const id of [...pending.keys()]) {
      cancel(id)
      await saveNow(id)
    }
  }
}))

/**
 * Apply a change to one map optimistically and schedule the write.
 *
 * Drawing emits changes at pointer speed, so the debounce is doing more work
 * here than anywhere else in the app: a freehand stroke is one write, not one
 * per sample.
 */
function patchMap(
  set: (partial: Partial<MapStore>) => void,
  get: () => MapStore,
  id: string,
  update: (map: StoryMap) => StoryMap
): void {
  set({ maps: get().maps.map((map) => (map.id === id ? update(map) : map)) })
  schedule(id)
}

function cancel(id: string): void {
  const timer = pending.get(id)
  if (timer) clearTimeout(timer)
  pending.delete(id)
}

function schedule(id: string): void {
  cancel(id)
  pending.set(
    id,
    setTimeout(() => {
      pending.delete(id)
      void saveNow(id)
    }, MAP_SAVE_DEBOUNCE_MS)
  )
}

async function saveNow(id: string): Promise<void> {
  const map = useMapStore.getState().maps.find((candidate) => candidate.id === id)
  if (!map) return
  const saved = await attempt(invoke('maps:save', { map }), 'Could not save the map')
  if (!saved) return
  // Main drops a drill-down link that would close a loop, so its version of the
  // shapes is the authority — but keep drawing done while the write was away.
  const current = useMapStore.getState().maps.find((candidate) => candidate.id === id)
  if (!current) return
  useMapStore.setState({
    maps: useMapStore.getState().maps.map((candidate) =>
      candidate.id === id
        ? {
            ...current,
            modified: saved.modified,
            shapes: current.shapes.map((shape) => {
              const authoritative = saved.shapes.find((item) => item.id === shape.id)
              return authoritative && authoritative.childMapId !== shape.childMapId
                ? { ...shape, childMapId: authoritative.childMapId }
                : shape
            })
          }
        : candidate
    )
  })
}
