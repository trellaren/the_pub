import type { DayStat } from '@shared/model/stats.js'

const HEADER = ['date', 'added', 'removed', 'net', 'minutes']

function escapeCsv(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** The daily table as CSV — a writer tracking their year in a spreadsheet gets a clean import. */
export function daysToCsv(days: readonly DayStat[]): string {
  const rows = days.map((day) => [day.date, day.added, day.removed, day.net, day.minutes].map(String))
  return [HEADER, ...rows].map((row) => row.map(escapeCsv).join(',')).join('\n')
}

/** A short plain-text summary, for "Copy stats" — pasteable into a message or notes app. */
export function daysToSummary(days: readonly DayStat[], todayKey: string, dailyTarget: number): string {
  const today = days.find((day) => day.date === todayKey)
  const totalAdded = days.reduce((sum, day) => sum + day.added, 0)
  const totalRemoved = days.reduce((sum, day) => sum + day.removed, 0)
  const totalNet = days.reduce((sum, day) => sum + day.net, 0)
  const lines = [
    `Today: +${today?.added ?? 0} / -${today?.removed ?? 0} words${dailyTarget > 0 ? ` (target ${dailyTarget})` : ''}`,
    `All time: +${totalAdded} / -${totalRemoved} (${totalNet >= 0 ? '+' : ''}${totalNet} net) over ${days.length} day${days.length === 1 ? '' : 's'}`
  ]
  return lines.join('\n')
}
