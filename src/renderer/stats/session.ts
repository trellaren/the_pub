import type { DayStat } from '@shared/model/stats.js'

/**
 * Pure writing-session and day-rollup logic.
 *
 * The clock is always a parameter, never read from `Date.now()` internally,
 * so every rule here tests as plain data — the `shared/pm/*.test.ts`
 * standard — rather than needing fake timers or a live editor. See
 * `docs/phase-13-plan.md`.
 */

export interface SessionState {
  /** When the current sitting started, or `null` if none is open. */
  openSince: number | null
  /** The most recent activity in the current sitting. */
  lastActivity: number | null
  /** Minutes already folded into a day's total from sittings that have closed. */
  minutesAccrued: number
}

export const INITIAL_SESSION_STATE: SessionState = {
  openSince: null,
  lastActivity: null,
  minutesAccrued: 0
}

function minutesBetween(startMs: number, endMs: number): number {
  return Math.round((endMs - startMs) / 60_000)
}

/**
 * An edit happened at `now`. Opens a sitting if none is open; extends the
 * current one if the gap since the last edit is within `idleTimeoutMs`;
 * otherwise closes the stale sitting (folding its minutes into
 * `minutesAccrued`) and opens a fresh one — this is the idle-gap split.
 */
export function recordActivity(state: SessionState, now: number, idleTimeoutMs: number): SessionState {
  if (state.openSince === null || state.lastActivity === null) {
    return { openSince: now, lastActivity: now, minutesAccrued: state.minutesAccrued }
  }
  const idleFor = now - state.lastActivity
  if (idleFor > idleTimeoutMs) {
    const closedMinutes = minutesBetween(state.openSince, state.lastActivity)
    return { openSince: now, lastActivity: now, minutesAccrued: state.minutesAccrued + closedMinutes }
  }
  return { ...state, lastActivity: now }
}

/**
 * Fold any open sitting into `minutesAccrued` and close it. Called on an idle
 * timer firing (nobody typed again to trigger the split in `recordActivity`)
 * and on project close, so a sitting that never sees another edit is not
 * lost.
 */
export function closeSession(state: SessionState, now: number, idleTimeoutMs: number): SessionState {
  if (state.openSince === null || state.lastActivity === null) return state
  // If the gap is already stale, the sitting ended at the last activity, not
  // at `now` — otherwise closing an idle sitting late would award it minutes
  // it never earned.
  const idleFor = now - state.lastActivity
  const endedAt = idleFor > idleTimeoutMs ? state.lastActivity : now
  const closedMinutes = minutesBetween(state.openSince, endedAt)
  return { openSince: null, lastActivity: null, minutesAccrued: state.minutesAccrued + closedMinutes }
}

/** Total active minutes so far, including whatever sitting is still open. */
export function activeMinutes(state: SessionState, now: number): number {
  if (state.openSince === null || state.lastActivity === null) return state.minutesAccrued
  return state.minutesAccrued + minutesBetween(state.openSince, Math.min(now, state.lastActivity + 1))
}

/**
 * The gross words added/removed/net for one before→after word-count change.
 *
 * Deliberately not a text diff: this is called once per autosave-debounced
 * change, on the before/after `countWords`, exactly as the plan specifies —
 * a same-tick add-and-cut nets to whichever is larger, which is the accepted
 * approximation for a debounce-granularity measurement.
 */
export function classifyDelta(before: number, after: number): { added: number; removed: number; net: number } {
  const net = after - before
  return { added: net > 0 ? net : 0, removed: net < 0 ? -net : 0, net }
}

/** The writer's local day for a timestamp, as 'YYYY-MM-DD'. Never UTC — see the plan. */
export function localDayKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function parseDayKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year!, (month ?? 1) - 1, day ?? 1)
}

/** `key` shifted by `deltaDays` local days. */
export function shiftDayKey(key: string, deltaDays: number): string {
  const date = parseDayKey(key)
  date.setDate(date.getDate() + deltaDays)
  return localDayKey(date)
}

/** Whole local days between two day keys (`to - from`), DST-safe. */
export function daysBetweenKeys(from: string, to: string): number {
  const a = parseDayKey(from)
  const b = parseDayKey(to)
  return Math.round((b.getTime() - a.getTime()) / 86_400_000)
}

/**
 * Apply one delta to a day, creating the row if it doesn't exist yet.
 * `byDoc` accumulates per-document net, not gross, matching the schema.
 */
export function applyDelta(
  day: DayStat | undefined,
  date: string,
  docId: string,
  delta: { added: number; removed: number; net: number },
  minutes: number
): DayStat {
  const base = day ?? { date, added: 0, removed: 0, net: 0, minutes: 0, byDoc: {} }
  return {
    date,
    added: base.added + delta.added,
    removed: base.removed + delta.removed,
    net: base.net + delta.net,
    minutes,
    byDoc: { ...base.byDoc, [docId]: (base.byDoc[docId] ?? 0) + delta.net }
  }
}

/**
 * Consecutive local days, ending at `asOf`, whose gross `added` met
 * `dailyTarget`. Stops at the first miss and at the project's first recorded
 * day — a day before the project existed is excluded, not counted as a miss,
 * per the plan.
 */
export function computeStreak(
  days: readonly DayStat[],
  dailyTarget: number,
  firstRecordedDate: string,
  asOf: string
): number {
  if (dailyTarget <= 0) return 0
  const byDate = new Map(days.map((entry) => [entry.date, entry]))
  let streak = 0
  let cursor = asOf
  while (daysBetweenKeys(firstRecordedDate, cursor) >= 0) {
    const entry = byDate.get(cursor)
    if (!entry || entry.added < dailyTarget) break
    streak++
    cursor = shiftDayKey(cursor, -1)
  }
  return streak
}

/**
 * Words-per-day needed to hit `target` by `deadline`, given `wordsSoFar`
 * already written — derived fresh from what remains and the days left, not a
 * fixed number set once, so it stays honest after a week off. `0` when there
 * is no target, no deadline, or the deadline has passed with words left.
 */
export function deriveDailyTarget(
  target: number,
  deadline: string,
  wordsSoFar: number,
  today: string
): number {
  if (target <= 0 || !deadline) return 0
  const remaining = target - wordsSoFar
  if (remaining <= 0) return 0
  const daysLeft = Math.max(1, daysBetweenKeys(today, deadline) + 1)
  if (daysLeft <= 0) return remaining
  return Math.ceil(remaining / daysLeft)
}
