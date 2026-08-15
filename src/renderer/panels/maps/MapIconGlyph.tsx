import type { JSX } from 'react'
import type { MapIcon } from '@shared/model/map.js'

/**
 * The marker glyphs, drawn rather than depended upon.
 *
 * Twenty specific shapes are not worth an icon library: the app has no icon
 * dependency at all today, its own toolbars use plain characters, and a general
 * set would bring thousands of glyphs to reach a castle and a bridge. These are
 * drawn on a 24x24 grid with one stroke weight so they read as one family at
 * marker size, and `Record<MapIcon, ...>` makes a missing one a build error.
 */
const ICON_PATHS: Record<MapIcon, JSX.Element> = {
  city: (
    <>
      <path d="M3 21V11l4-2v12" />
      <path d="M7 21V7l5-3 5 3v14" />
      <path d="M17 21V11l4 2v8" />
      <path d="M10 21v-4h4v4" />
    </>
  ),
  town: (
    <>
      <path d="M4 21v-8l4-3 4 3v8" />
      <path d="M12 21v-6l4-3 4 3v6" />
      <path d="M7 21v-3h2v3" />
    </>
  ),
  village: (
    <>
      <path d="M3 21v-6l4-3 4 3v6" />
      <path d="M14 21v-4l3-2 3 2v4" />
    </>
  ),
  castle: (
    <>
      <path d="M3 21V8l3 2V8l3 2V8l3 2V8l3 2V8l3 2v11" />
      <path d="M3 21h18" />
      <path d="M10 21v-5h4v5" />
    </>
  ),
  tower: (
    <>
      <path d="M9 21V6l3-3 3 3v15" />
      <path d="M9 10h6" />
      <path d="M7 21h10" />
    </>
  ),
  bridge: (
    <>
      <path d="M2 16h20" />
      <path d="M2 16c4-7 16-7 20 0" />
      <path d="M7 13v8" />
      <path d="M17 13v8" />
    </>
  ),
  forest: (
    <>
      <path d="M8 3 3 13h10L8 3Z" />
      <path d="M8 13v8" />
      <path d="M17 7l-4 8h8l-4-8Z" />
      <path d="M17 15v6" />
    </>
  ),
  mountain: (
    <>
      <path d="M2 20 9 7l5 8 2-3 6 8H2Z" />
      <path d="M6.5 13.5 9 11l2 3" />
    </>
  ),
  cave: (
    <>
      <path d="M3 21V13a9 9 0 0 1 18 0v8" />
      <path d="M9 21v-4a3 3 0 0 1 6 0v4" />
    </>
  ),
  ruins: (
    <>
      <path d="M4 21V9l3 3V7l3 3" />
      <path d="M14 21V8l3 4V10l3 3v8" />
      <path d="M2 21h20" />
    </>
  ),
  temple: (
    <>
      <path d="M3 9 12 3l9 6" />
      <path d="M5 9v10" />
      <path d="M10 9v10" />
      <path d="M14 9v10" />
      <path d="M19 9v10" />
      <path d="M3 21h18" />
    </>
  ),
  farm: (
    <>
      <path d="M3 21V10l7-4 7 4v11" />
      <path d="M3 21h18" />
      <path d="M8 21v-6h4v6" />
      <path d="M19 21v-7" />
    </>
  ),
  mine: (
    <>
      <path d="M12 13 3 21" />
      <path d="M9 6a7 7 0 0 1 10 6" />
      <path d="M5 12a7 7 0 0 1 5-6" />
      <path d="m14 11 5 5" />
    </>
  ),
  port: (
    <>
      <path d="M12 7v12" />
      <circle cx="12" cy="4" r="2" />
      <path d="M8 10h8" />
      <path d="M5 13a7 7 0 0 0 14 0" />
    </>
  ),
  lighthouse: (
    <>
      <path d="M9 21 10 8h4l1 13" />
      <path d="M9.5 14h5" />
      <path d="M12 8V4" />
      <path d="m5 7 3 1" />
      <path d="m19 7-3 1" />
      <path d="M7 21h10" />
    </>
  ),
  camp: (
    <>
      <path d="M12 4 3 21h18L12 4Z" />
      <path d="M12 10v11" />
    </>
  ),
  crossroads: (
    <>
      <path d="M12 2v20" />
      <path d="M2 12h20" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  flag: (
    <>
      <path d="M6 21V3" />
      <path d="M6 4h11l-2.5 4L17 12H6" />
    </>
  ),
  star: <path d="m12 3 2.6 5.8 6.4.7-4.8 4.3 1.4 6.2L12 17l-5.6 3 1.4-6.2L3 9.5l6.4-.7L12 3Z" />,
  waypoint: (
    <>
      <path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z" />
      <circle cx="12" cy="10" r="2.5" />
    </>
  )
}

/** One glyph, inheriting the marker's colour unless told otherwise. */
export function MapIconGlyph({
  icon,
  size = 24,
  color = 'currentColor'
}: {
  icon: MapIcon
  size?: number
  color?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICON_PATHS[icon]}
    </svg>
  )
}
