import { describe, it, expect } from 'vitest'
import {
  INITIAL_SESSION_STATE,
  recordActivity,
  closeSession,
  activeMinutes,
  classifyDelta,
  localDayKey,
  shiftDayKey,
  daysBetweenKeys,
  applyDelta,
  computeStreak,
  deriveDailyTarget
} from './session.js'

const MIN = 60_000
const IDLE = 5 * MIN

describe('session tracking', () => {
  it('opens a session on the first edit', () => {
    const state = recordActivity(INITIAL_SESSION_STATE, 1000, IDLE)
    expect(state.openSince).toBe(1000)
    expect(state.lastActivity).toBe(1000)
  })

  it('extends a session across a short gap', () => {
    let state = recordActivity(INITIAL_SESSION_STATE, 0, IDLE)
    state = recordActivity(state, 2 * MIN, IDLE)
    state = recordActivity(state, 4 * MIN, IDLE)
    expect(state.openSince).toBe(0)
    expect(state.minutesAccrued).toBe(0)
    expect(activeMinutes(state, 4 * MIN)).toBe(4)
  })

  it('splits one sitting into two across an idle gap', () => {
    let state = recordActivity(INITIAL_SESSION_STATE, 0, IDLE)
    state = recordActivity(state, 3 * MIN, IDLE)
    // Gap of 10 minutes > 5 minute idle timeout: the first sitting closes.
    state = recordActivity(state, 13 * MIN, IDLE)
    expect(state.minutesAccrued).toBe(3)
    expect(state.openSince).toBe(13 * MIN)
  })

  it('a burst of edits within the idle window stays one session', () => {
    let state = INITIAL_SESSION_STATE
    for (let t = 0; t <= 20 * MIN; t += MIN) {
      state = recordActivity(state, t, IDLE)
    }
    expect(state.minutesAccrued).toBe(0)
    expect(activeMinutes(state, 20 * MIN)).toBe(20)
  })

  it('closeSession folds the open sitting and clears it', () => {
    let state = recordActivity(INITIAL_SESSION_STATE, 0, IDLE)
    state = recordActivity(state, 5 * MIN, IDLE)
    state = closeSession(state, 5 * MIN, IDLE)
    expect(state.openSince).toBeNull()
    expect(state.minutesAccrued).toBe(5)
  })

  it('closeSession does not award minutes for time idle beyond the timeout', () => {
    let state = recordActivity(INITIAL_SESSION_STATE, 0, IDLE)
    state = recordActivity(state, 2 * MIN, IDLE)
    // Closed an hour later, having gone idle at minute 2.
    state = closeSession(state, 60 * MIN, IDLE)
    expect(state.minutesAccrued).toBe(2)
  })

  it('closing with no open session is a no-op', () => {
    expect(closeSession(INITIAL_SESSION_STATE, 1000, IDLE)).toEqual(INITIAL_SESSION_STATE)
  })
})

describe('classifyDelta', () => {
  it('reports gross added on a growing count', () => {
    expect(classifyDelta(100, 150)).toEqual({ added: 50, removed: 0, net: 50 })
  })

  it('reports gross removed on a shrinking count', () => {
    expect(classifyDelta(150, 100)).toEqual({ added: 0, removed: 50, net: -50 })
  })

  it('a revision that nets negative is still reported as removal, not zero', () => {
    // 2000 cut, 1800 written: net -200, but the writer did real work.
    const delta = classifyDelta(2000, 1800)
    expect(delta).toEqual({ added: 0, removed: 200, net: -200 })
  })

  it('no change is zero on both sides', () => {
    expect(classifyDelta(80, 80)).toEqual({ added: 0, removed: 0, net: 0 })
  })
})

describe('localDayKey', () => {
  it('stays on the same local day either side of midnight', () => {
    const before = new Date(2026, 0, 15, 23, 59)
    const after = new Date(2026, 0, 16, 0, 1)
    expect(localDayKey(before)).toBe('2026-01-15')
    expect(localDayKey(after)).toBe('2026-01-16')
  })

  it('shiftDayKey and daysBetweenKeys agree across a month boundary', () => {
    expect(shiftDayKey('2026-01-31', 1)).toBe('2026-02-01')
    expect(daysBetweenKeys('2026-01-31', '2026-02-01')).toBe(1)
  })

  it('daysBetweenKeys is stable across a spring-forward DST change (US)', () => {
    // 2026-03-08 is a DST transition in US timezones; a naive ms/86400000
    // diff on UTC-anchored dates would misreport this as a fraction of a day.
    expect(daysBetweenKeys('2026-03-07', '2026-03-09')).toBe(2)
  })
})

describe('applyDelta', () => {
  it('creates a fresh day row on first delta', () => {
    const day = applyDelta(undefined, '2026-01-01', 'doc-1', { added: 10, removed: 0, net: 10 }, 3)
    expect(day).toEqual({ date: '2026-01-01', added: 10, removed: 0, net: 10, minutes: 3, byDoc: { 'doc-1': 10 } })
  })

  it('accumulates gross and per-doc net across multiple deltas and documents', () => {
    let day = applyDelta(undefined, '2026-01-01', 'doc-1', { added: 100, removed: 0, net: 100 }, 5)
    day = applyDelta(day, '2026-01-01', 'doc-1', { added: 0, removed: 30, net: -30 }, 8)
    day = applyDelta(day, '2026-01-01', 'doc-2', { added: 20, removed: 0, net: 20 }, 8)
    expect(day.added).toBe(120)
    expect(day.removed).toBe(30)
    expect(day.net).toBe(90)
    expect(day.byDoc).toEqual({ 'doc-1': 70, 'doc-2': 20 })
    expect(day.minutes).toBe(8)
  })
})

describe('computeStreak', () => {
  const days = [
    { date: '2026-01-01', added: 500, removed: 0, net: 500, minutes: 10, byDoc: {} },
    { date: '2026-01-02', added: 600, removed: 0, net: 600, minutes: 10, byDoc: {} },
    { date: '2026-01-03', added: 100, removed: 0, net: 100, minutes: 10, byDoc: {} }, // below target
    { date: '2026-01-04', added: 500, removed: 0, net: 500, minutes: 10, byDoc: {} },
    { date: '2026-01-05', added: 500, removed: 0, net: 500, minutes: 10, byDoc: {} }
  ]

  it('counts consecutive days meeting the target, ending at asOf', () => {
    expect(computeStreak(days, 500, '2026-01-01', '2026-01-05')).toBe(2)
  })

  it('a day below target breaks the streak', () => {
    expect(computeStreak(days, 500, '2026-01-01', '2026-01-03')).toBe(0)
  })

  it('a gap (missing day) breaks the streak same as a miss', () => {
    const withGap = [days[0]!, days[3]!, days[4]!] // missing 01-02
    expect(computeStreak(withGap, 500, '2026-01-01', '2026-01-05')).toBe(2)
    expect(computeStreak(withGap, 500, '2026-01-01', '2026-01-01')).toBe(1)
  })

  it('excludes days before the project first recorded, rather than counting them as misses', () => {
    // firstRecordedDate is 01-04, so the streak walking back stops there,
    // clean, instead of finding "missing" 01-03/01-02/01-01 and zeroing out.
    expect(computeStreak(days, 500, '2026-01-04', '2026-01-05')).toBe(2)
  })

  it('zero dailyTarget means no streak is defined', () => {
    expect(computeStreak(days, 0, '2026-01-01', '2026-01-05')).toBe(0)
  })
})

describe('deriveDailyTarget', () => {
  it('derives from words remaining and days left', () => {
    // 10 days left inclusive of today, 5000 remaining -> 500/day
    expect(deriveDailyTarget(10_000, '2026-01-10', 5_000, '2026-01-01')).toBe(500)
  })

  it('rises after missed days, since it derives from what remains each time', () => {
    const day1 = deriveDailyTarget(10_000, '2026-01-10', 0, '2026-01-01')
    // Five days pass with no writing at all.
    const day6 = deriveDailyTarget(10_000, '2026-01-10', 0, '2026-01-06')
    expect(day6).toBeGreaterThan(day1)
  })

  it('is zero with no target or no deadline', () => {
    expect(deriveDailyTarget(0, '2026-01-10', 0, '2026-01-01')).toBe(0)
    expect(deriveDailyTarget(10_000, '', 0, '2026-01-01')).toBe(0)
  })

  it('is zero once the target is already met', () => {
    expect(deriveDailyTarget(10_000, '2026-01-10', 10_000, '2026-01-01')).toBe(0)
  })
})
