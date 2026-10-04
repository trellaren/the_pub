import { useState } from 'react'
import type { MapIcon } from '@shared/model/map.js'
import { DEFAULT_STROKE_WIDTH, DEFAULT_AREA_OPACITY } from '@shared/model/map.js'

export interface Brush {
  color: string
  setColor: (color: string) => void
  icon: MapIcon | null
  setIcon: (icon: MapIcon | null) => void
  strokeWidth: number
  setStrokeWidth: (width: number) => void
  opacity: number
  setOpacity: (opacity: number) => void
}

export function useBrush(): Brush {
  const [color, setColor] = useState('#7aa2f7')
  const [icon, setIcon] = useState<MapIcon | null>(null)
  const [strokeWidth, setStrokeWidth] = useState(DEFAULT_STROKE_WIDTH)
  const [opacity, setOpacity] = useState(DEFAULT_AREA_OPACITY)
  return { color, setColor, icon, setIcon, strokeWidth, setStrokeWidth, opacity, setOpacity }
}
