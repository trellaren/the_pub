import type { DayStat } from '@shared/model/stats.js'

const BAR_WIDTH = 6
const GAP = 2
const HALF_HEIGHT = 48

/**
 * The last 90 local days as a bar chart: added above the axis, removed below.
 * Deliberately not net-only — see `docs/phase-13-plan.md`'s "the single most
 * important line in the schema" — a cut-heavy revision day must not look like
 * a day of no work.
 *
 * Hand-drawn SVG, following `MapCanvas.tsx`'s convention: no charting
 * dependency for two shapes this simple.
 */
export function ProgressChart({ days, dailyTarget }: { days: DayStat[]; dailyTarget: number }) {
  const width = days.length * (BAR_WIDTH + GAP)
  const height = HALF_HEIGHT * 2 + 16
  const axisY = HALF_HEIGHT + 8
  const max = Math.max(dailyTarget, 1, ...days.map((day) => Math.max(day.added, day.removed)))

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-28 w-full"
      role="img"
      aria-label="Words added and removed over the last 90 days"
    >
      {dailyTarget > 0 ? (
        <line
          x1={0}
          x2={width}
          y1={axisY - (dailyTarget / max) * HALF_HEIGHT}
          y2={axisY - (dailyTarget / max) * HALF_HEIGHT}
          className="stroke-accent/50"
          strokeDasharray="2 2"
          strokeWidth={1}
        />
      ) : null}
      <line x1={0} x2={width} y1={axisY} y2={axisY} className="stroke-border" strokeWidth={1} />
      {days.map((day, index) => {
        const x = index * (BAR_WIDTH + GAP)
        const addedHeight = (Math.min(day.added, max) / max) * HALF_HEIGHT
        const removedHeight = (Math.min(day.removed, max) / max) * HALF_HEIGHT
        return (
          <g key={day.date}>
            <title>
              {day.date}: +{day.added} / -{day.removed} ({day.net >= 0 ? '+' : ''}
              {day.net} net)
            </title>
            <rect
              x={x}
              y={axisY - addedHeight}
              width={BAR_WIDTH}
              height={addedHeight}
              className="fill-accent"
            />
            <rect x={x} y={axisY} width={BAR_WIDTH} height={removedHeight} className="fill-danger" />
          </g>
        )
      })}
    </svg>
  )
}

/** A small inline sparkline of `net` for a per-document/part breakdown row. */
export function Sparkline({ values }: { values: number[] }) {
  if (values.length === 0) return null
  const width = 60
  const height = 16
  const max = Math.max(1, ...values.map((value) => Math.abs(value)))
  const step = width / Math.max(1, values.length - 1)
  const points = values
    .map((value, index) => `${index * step},${height / 2 - (value / max) * (height / 2)}`)
    .join(' ')
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-4 w-16 shrink-0" role="presentation">
      <line x1={0} x2={width} y1={height / 2} y2={height / 2} className="stroke-border" strokeWidth={0.5} />
      <polyline points={points} className="fill-none stroke-accent" strokeWidth={1.5} />
    </svg>
  )
}
